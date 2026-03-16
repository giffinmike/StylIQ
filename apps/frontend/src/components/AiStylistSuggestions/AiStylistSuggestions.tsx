import React, {useEffect, useState, useRef} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  AppState,
  Switch,
  ScrollView,
  Pressable,
  Image,
  Alert,
  Modal,
  Dimensions,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import * as Animatable from 'react-native-animatable';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
import {API_BASE_URL} from '../../config/api';
import PushNotification from 'react-native-push-notification';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {tokens} from '../../styles/tokens/tokens';
import {useAppTheme} from '../../context/ThemeContext';
import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
import {fontScale, moderateScale} from '../../utils/scale';
import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
import {useResponsive} from '../../hooks/useResponsive';
import {useWindowDimensions} from 'react-native';
import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
import {SafeAreaView} from 'react-native-safe-area-context';
import {findNodeHandle, UIManager} from 'react-native';
import {DynamicIsland} from '../../native/dynamicIsland';
import {getAccessToken} from '../../utils/auth';
import {useUUID, useUUIDInitialized} from '../../context/UUIDContext';
import {fetchWardrobeItems} from '../../hooks/useWardrobeItems';
import {useQueryClient} from '@tanstack/react-query';
import WardrobePickerModal from '../WardrobePickerModal/WardrobePickerModal';
import ViewShot from 'react-native-view-shot';
import FastImage from 'react-native-fast-image';
import {refineOutfitShoes} from './shoeCompatibility';

type Props = {
  weather: any;
  navigate: (screen: string, params?: any) => void;
  userName?: string;
  wardrobe?: any[];
  preferences?: any;
};

// Legacy text-based response type (backward compatibility)
export type AiSuggestionResponse = {
  suggestion: string;
  insight?: string;
  tomorrow?: string;
  seasonalForecast?: string;
  lifecycleForecast?: string;
  styleTrajectory?: string;
};

// New visual outfit types
type OutfitItem = {
  id: string;
  name: string;
  imageUrl: string;
  category: 'top' | 'bottom' | 'outerwear' | 'shoes' | 'accessory';
};

type OutfitSuggestion = {
  id: string;
  rank: 1 | 2 | 3;
  summary: string;
  items: OutfitItem[];
  reasoning?: string;
};

type AiSuggestionResponseV2 = {
  weatherSummary?: string;
  outfits: OutfitSuggestion[];
};

// Union type for handling both formats
type AiSuggestionData = AiSuggestionResponse | AiSuggestionResponseV2;

// Local normalizer — ensures every AI Stylist outfit has a renderable summary
function normalizeStylistOutfit(outfit: OutfitSuggestion): OutfitSuggestion {
  const summary =
    typeof outfit.summary === 'string' && outfit.summary.trim().length > 0
      ? outfit.summary
      : ' ';
  return {...outfit, summary};
}

function normalizeStylistData(data: AiSuggestionData): AiSuggestionData {
  if ('outfits' in data && Array.isArray((data as any).outfits)) {
    return {
      ...data,
      outfits: (data as AiSuggestionResponseV2).outfits.map(
        normalizeStylistOutfit,
      ),
    };
  }
  return data;
}

// 🕐 Cooldown windows
const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
const STORAGE_KEY = 'aiStylistAutoMode';

// ✅ ADD — persistent suggestion key
const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// ✅ Persistent expanded state key
const AI_SUGGESTION_EXPANDED_KEY = 'aiStylist_isExpanded';

// ✅ Persistent active outfit index key
const AI_ACTIVE_OUTFIT_INDEX_KEY = 'aiStylist_activeOutfitIndex';

const AiStylistSuggestions: React.FC<Props> = ({
  weather,
  navigate,
  userName = 'You',
  wardrobe: propWardrobe = [],
  preferences = {},
}) => {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();

  // Fetch real wardrobe directly via UUID context
  const contextUUID = useUUID();
  const isUUIDInitialized = useUUIDInitialized();
  const [realWardrobe, setRealWardrobe] = useState<any[]>([]);

  // Use real wardrobe if fetched, otherwise fall back to prop
  const wardrobe = realWardrobe.length > 0 ? realWardrobe : propWardrobe;

  const containerRef = useRef<View>(null);

  const [aiData, setAiData] = useState<AiSuggestionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAutoMode, setIsAutoMode] = useState(false);

  // Visual outfit state
  const [activeOutfitIndex, setActiveOutfitIndex] = useState(0);
  const [showTweakSheet, setShowTweakSheet] = useState(false);
  const [swappingCategory, setSwappingCategory] = useState<string | null>(null); // Track which category is being swapped
  const [isSaving, setIsSaving] = useState(false); // Track outfit saving state
  const [showSwapPicker, setShowSwapPicker] = useState(false); // Show wardrobe picker for swap
  const [swapPickerCategory, setSwapPickerCategory] = useState<string | null>(null); // Category to filter picker
  const [fullScreenOutfitIndex, setFullScreenOutfitIndex] = useState<number | null>(null); // Full screen modal outfit index

  const queryClient = useQueryClient();
  const lastSuggestionRef = useRef<string | null>(null);
  const lastNotifyTimeRef = useRef<number>(0);
  const lastFetchTimeRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasRefetchedForRealWardrobe = useRef(false);
  const fetchSuggestionRef = useRef<((trigger: string) => void) | null>(null);
  const swapSingleItemRef = useRef<((category: string, keepIds: string[]) => void) | null>(null);
  const snapshotRef = useRef<ViewShot>(null);

  // Capture and upload outfit snapshot for saved outfits
  const captureAndUploadSnapshot = async (): Promise<string | null> => {
    try {
      if (!snapshotRef.current?.capture) {
        console.log('[AiStylist] Snapshot ref not available');
        return null;
      }

      const uri = await snapshotRef.current.capture();
      if (!uri) {
        console.log('[AiStylist] Failed to capture snapshot');
        return null;
      }

      const accessToken = await getAccessToken();
      const filename = `ai-outfit-snapshot-${Date.now()}.png`;

      // Get presigned URL for upload
      const presignRes = await fetch(
        `${API_BASE_URL}/upload/presign?filename=${encodeURIComponent(filename)}&contentType=image/png`,
        {headers: {Authorization: `Bearer ${accessToken}`}},
      );

      if (!presignRes.ok) {
        console.error('[AiStylist] Failed to get presign URL');
        return null;
      }

      const {uploadUrl, publicUrl} = await presignRes.json();

      // Read file and upload
      const response = await fetch(uri);
      const blob = await response.blob();

      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {'Content-Type': 'image/png'},
        body: blob,
      });

      if (!uploadRes.ok) {
        console.error('[AiStylist] Failed to upload snapshot');
        return null;
      }

      console.log('[AiStylist] Snapshot uploaded:', publicUrl);
      return publicUrl;
    } catch (err) {
      console.error('[AiStylist] Snapshot capture error:', err);
      return null;
    }
  };

  // Fetch real wardrobe when component mounts and UUID is available
  // IMPORTANT: Do NOT clear cache here - only update wardrobe reference
  useEffect(() => {
    if (contextUUID && isUUIDInitialized) {
      fetchWardrobeItems(contextUUID)
        .then(items => {
          if (items && items.length > 0) {
            setRealWardrobe(items);
            // Do NOT clear cache on every mount - preserve existing suggestions
          }
        })
        .catch(err => console.error('[AiStylist] Fetch failed:', err));
    }
  }, [contextUUID, isUUIDInitialized]);

  // Fetch AI suggestion when real wardrobe is loaded AND no cached data exists (one-time)
  useEffect(() => {
    const shouldFetch =
      realWardrobe.length > 0 &&
      !hasRefetchedForRealWardrobe.current &&
      weather?.fahrenheit?.main?.temp &&
      !aiData; // Only fetch if we don't already have data

    if (shouldFetch) {
      hasRefetchedForRealWardrobe.current = true;
      // Delay slightly to ensure fetchSuggestion ref is set
      setTimeout(() => {
        if (fetchSuggestionRef.current) {
          fetchSuggestionRef.current('realWardrobe');
        }
      }, 100);
    }
  }, [realWardrobe, weather, aiData]);

  const [isExpanded, setIsExpanded] = useState(true); // Default to expanded
  const toggleExpanded = () => setIsExpanded(prev => !prev);

  const {width, isXS, isSM, isMD} = useResponsive();

  // inside AiStylistSuggestions component
  const {width: screenWidth} = useWindowDimensions();
  const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

  const scrollRef = useRef<ScrollView>(null);

  // Type guard to check if response is new visual format
  const isVisualFormat = (
    data: AiSuggestionData | null,
  ): data is AiSuggestionResponseV2 => {
    return data !== null && 'outfits' in data && Array.isArray(data.outfits);
  };

  // Type guard to check if response is legacy text format
  const isTextFormat = (
    data: AiSuggestionData | null,
  ): data is AiSuggestionResponse => {
    return data !== null && 'suggestion' in data;
  };

  // Get current outfit from visual format
  const getCurrentOutfit = (): OutfitSuggestion | null => {
    if (!aiData || !isVisualFormat(aiData)) return null;
    const outfit = aiData.outfits[activeOutfitIndex] || null;
    console.log('[AIStylist] RENDERING_OUTFITS', {
      totalOutfits: aiData.outfits.length,
      activeIndex: activeOutfitIndex,
      shoeItem: outfit?.items?.find(i => i.category === 'shoes'),
    });
    return outfit;
  };

  // Emit a learning signal from home actions (fire-and-forget)
  const emitHomeSignal = (
    eventType: string,
    entityId?: string,
    features?: Record<string, any>,
  ) => {
    if (!contextUUID) return;
    getAccessToken()
      .then(token =>
        fetch(`${API_BASE_URL}/outfit/home-signal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            event_type: eventType,
            entity_id: entityId,
            extracted_features: features,
          }),
        }),
      )
      .catch(() => {});
  };

  // Build extracted features from local outfit items (no extra API call)
  const buildOutfitFeatures = (items: OutfitItem[]) => ({
    item_ids: items.map(i => i.id),
    categories: items.map(i => i.category),
  });

  // ============================================
  // Feature-local completeness enhancer (render-layer only)
  // Does NOT modify backend, does NOT write to DB, does NOT persist.
  // Only operates in-memory on items already returned by AI.
  // ============================================
  const ensureExecutiveCompleteness = (items: OutfitItem[]): OutfitItem[] => {
    if (!items || items.length === 0) return items;

    const categories = new Set(items.map(i => i.category));
    const accessories = items.filter(i => i.category === 'accessory');
    const hasBottom = categories.has('bottom');

    // If trousers/bottom present and a belt exists in the original items but was
    // somehow filtered, ensure it's included. Since we only work with items
    // already returned, this is a no-op guard — all items pass through.
    // If no accessory exists at all, allow any accessory already in the list.
    // If a bag exists in the original items, include it.
    // Since we do NOT fabricate items, we simply return all items unfiltered.
    // The real value: we guarantee no item is dropped from the returned set.

    return items;
  };

  // ============================================
  // Visual Outfit Components (inline)
  // ============================================

  // Outfit layout - composite snapshot + grid of individual items (like saved outfits card)
  const OutfitStrip = ({items: rawItems, outfitIndex}: {items: OutfitItem[]; outfitIndex: number}) => {
    const items = ensureExecutiveCompleteness(rawItems);
    // Sort items by category for proper layering: top → outerwear → bottom → shoes → accessory
    const categoryOrder = ['top', 'outerwear', 'bottom', 'shoes', 'accessory'];
    const sortedItems = [...items].sort(
      (a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category),
    );

    // Get items by category for snapshot composition
    const topItem = items.find(i => i.category === 'top');
    const outerwearItem = items.find(i => i.category === 'outerwear');
    const bottomItem = items.find(i => i.category === 'bottom');
    const shoesItem = items.find(i => i.category === 'shoes');
    const accessoryItems = items.filter(i => i.category === 'accessory');

    return (
      <View style={{alignItems: 'center'}}>
        {/* Composite snapshot - full width centered */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => setFullScreenOutfitIndex(outfitIndex)}
          style={{
            width: '100%',
            height: 300,
            borderRadius: tokens.borderRadius.xxl,
            overflow: 'hidden',
            // backgroundColor: theme.colors.imageBackground,
            flexDirection: 'row',
            marginVertical: 12
          }}>

          {/* Left column: Outerwear */}
          <View style={{width: 110, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 80, backgroundColor: theme.colors.imageBackground2}}>
            {outerwearItem && (
              <Image
                source={{uri: outerwearItem.imageUrl}}
                style={{width: 110, height: 110}}
                resizeMode="contain"
              />
            )}
          </View>

          {/* Center column: Top → Bottom → Shoes (overlapping) */}
          <View style={{flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 10, backgroundColor: theme.colors.imageBackground2}}>
            {topItem && (
              <Image
                source={{uri: topItem.imageUrl}}
                style={{width: 130, height: 130, zIndex: 3, marginRight: 35}}
                resizeMode="contain"
              />
            )}
            {bottomItem && (
              <Image
                source={{uri: bottomItem.imageUrl}}
                style={{width: 130, height: 130, marginTop: -25, marginRight: 35, zIndex: 2}}
                resizeMode="contain"
              />
            )}
            {shoesItem && (
              <Image
                source={{uri: shoesItem.imageUrl}}
                style={{width: 65, height: 65, marginTop: -20, marginRight: 50, zIndex: 1}}
                resizeMode="contain"
              />
            )}
          </View>

          {/* Right column: Accessories */}
          <View style={{width: 65, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 14, gap: 8, backgroundColor: theme.colors.imageBackground2}}>
            {accessoryItems.map((acc, idx) => (
              <Image
                key={`${acc.id}-${idx}`}
                source={{uri: acc.imageUrl}}
                style={{width: 110, height: 110, marginRight: 65, marginTop: 70}}
                resizeMode="contain"
              />
            ))}
          </View>
        </TouchableOpacity>

      </View>
    );
  };

  // Rank badge showing "1st Pick", "2nd Pick", etc.
  const RankBadge = ({rank}: {rank: 1 | 2 | 3}) => {
    const labels: Record<1 | 2 | 3, string> = {
      1: '1st Pick',
      2: '2nd Pick',
      3: '3rd Pick',
    };
    const colors: Record<1 | 2 | 3, string> = {
      1: theme.colors.button1,
      2: theme.colors.foreground2,
      3: theme.colors.muted,
    };
    return (
      <View
        style={{
          backgroundColor: colors[rank],
          paddingHorizontal: moderateScale(tokens.spacing.xs),
          paddingVertical: 2,
          borderRadius: 50,
          alignSelf: 'flex-start',
          // marginBottom: moderateScale(tokens.spacing.xs),
        }}>
        <Text
          style={{
            color: rank === 1 ? '#fff' : theme.colors.background,
            fontSize: fontScale(tokens.fontSize.xxs),
            fontWeight: tokens.fontWeight.semiBold,
            paddingVertical: 3,
            paddingHorizontal: 3
          }}>
          {labels[rank]}
        </Text>
      </View>
    );
  };

  // Handle swapping an item from the wardrobe picker
  const handleSwapItem = (wardrobeItem: any) => {
    if (!aiData || !isVisualFormat(aiData) || !swappingCategory) return;

    // Build image URL from wardrobe item (same priority as WardrobePickerModal)
    const imageUrl =
      wardrobeItem.image ||
      wardrobeItem.touchedUpImageUrl ||
      wardrobeItem.processedImageUrl ||
      wardrobeItem.thumbnailUrl ||
      wardrobeItem.image_url ||
      '';

    // Create new outfit item from wardrobe item
    const newOutfitItem: OutfitItem = {
      id: wardrobeItem.id,
      name: wardrobeItem.name || wardrobeItem.label || 'Item',
      imageUrl: imageUrl,
      category: swappingCategory as OutfitItem['category'],
    };

    // Update the current outfit's items
    const updatedOutfits = aiData.outfits.map((outfit, idx) => {
      if (idx !== activeOutfitIndex) return outfit;
      return {
        ...outfit,
        items: outfit.items.map(item =>
          item.category === swappingCategory ? newOutfitItem : item,
        ),
      };
    });

    let updatedAiData: AiSuggestionData = {...aiData, outfits: updatedOutfits};

    // Re-refine after manual swap to catch any new shoe incompatibility
    if ('outfits' in updatedAiData && Array.isArray(updatedAiData.outfits) && wardrobe.length > 0) {
      updatedAiData = refineOutfitShoes(updatedAiData as any, wardrobe) as AiSuggestionData;
    }

    setAiData(updatedAiData);

    // Persist the updated data to cache so it survives navigation
    AsyncStorage.setItem(AI_SUGGESTION_STORAGE_KEY, JSON.stringify({
      ...updatedAiData,
      __cacheDate: new Date().toDateString(),
      __weatherTemp: weather?.fahrenheit?.main?.temp,
    })).catch(() => {
      // Silent fail - swap still works locally
    });

    // Emit learning signal for manual item swap
    emitHomeSignal('SLOT_OVERRIDE', undefined, {
      categories: [swappingCategory],
    });

    setShowSwapPicker(false);
    setSwappingCategory(null);
    setSwapPickerCategory(null);
  };

  // Save outfit to Saved Outfits (custom-outfits endpoint)
  const handleSaveOutfit = async () => {
    const currentOutfit = getCurrentOutfit();
    if (!currentOutfit || !contextUUID) {
      Alert.alert('Error', 'Unable to save outfit. Please try again.');
      return;
    }

    // Extract item IDs by category from the outfit
    const items = currentOutfit.items || [];
    const topItem = items.find(i => i.category === 'top');
    const bottomItem = items.find(i => i.category === 'bottom');
    const shoesItem = items.find(i => i.category === 'shoes');

    if (!topItem && !bottomItem && !shoesItem) {
      Alert.alert('Error', 'No items found in this outfit.');
      return;
    }

    setIsSaving(true);
    try {
      // Capture outfit snapshot for thumbnail
      const thumbnailUrl = await captureAndUploadSnapshot();

      const accessToken = await getAccessToken();
      const response = await fetch(`${API_BASE_URL}/custom-outfits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          user_id: contextUUID,
          name: (currentOutfit as any).title || currentOutfit.summary?.split(/[.!?]/)[0]?.slice(0, 60)?.trim() || 'AI Stylist Suggestion',
          top_id: topItem?.id ?? null,
          bottom_id: bottomItem?.id ?? null,
          shoes_id: shoesItem?.id ?? null,
          accessory_ids: items
            .filter(i => i.category === 'accessory' || i.category === 'outerwear')
            .map(i => i.id),
          metadata: {
            source: 'ai_stylist',
            rank: currentOutfit.rank,
          },
          thumbnail_url: thumbnailUrl,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Save outfit failed:', response.status, errorText);
        throw new Error(`Failed to save outfit: ${response.status}`);
      }

      // Invalidate saved-outfits cache so SavedOutfitsScreen refreshes
      queryClient.invalidateQueries({queryKey: ['saved-outfits', contextUUID]});

      // Emit learning signal for outfit saved from home
      emitHomeSignal(
        'OUTFIT_SAVED_FROM_HOME',
        currentOutfit.id,
        buildOutfitFeatures(items),
      );

      Alert.alert('Saved!', 'Outfit added to your Saved Outfits.', [
        {text: 'View Saved', onPress: () => navigate('SavedOutfits', {})},
        {text: 'OK'},
      ]);
    } catch (err) {
      console.error('Error saving outfit:', err);
      Alert.alert('Error', 'Failed to save outfit. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // Action buttons: Wear this, Next, Tweak
  const ActionButtons = () => {
    const totalOutfits = isVisualFormat(aiData) ? aiData.outfits.length : 0;

    return (
      <View
        style={{
          flexDirection: 'row',
          marginTop: moderateScale(tokens.spacing.sm),
          gap: moderateScale(tokens.spacing.xs),
        }}>
        {/* Wear this - Primary (saves outfit) */}
        <TouchableOpacity
          onPress={handleSaveOutfit}
          disabled={isSaving}
          style={{
            flex: 2,
            backgroundColor: isSaving ? theme.colors.muted : theme.colors.button1,
            paddingVertical: moderateScale(tokens.spacing.sm),
            borderRadius: tokens.borderRadius.sm,
            alignItems: 'center',
          }}>
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text
              style={{
                color: '#fff',
                fontWeight: tokens.fontWeight.semiBold,
                fontSize: fontScale(tokens.fontSize.md),
              }}>
              Save Outfit
            </Text>
          )}
        </TouchableOpacity>

        {/* Next option */}
        <TouchableOpacity
          onPress={() =>
            setActiveOutfitIndex(prev => (prev + 1) % totalOutfits)
          }
          style={{
            flex: 1,
            backgroundColor: theme.colors.button1,
            paddingVertical: moderateScale(tokens.spacing.sm),
            borderRadius: tokens.borderRadius.sm,
            alignItems: 'center',
            // borderWidth: theme.borderWidth.hairline,
            // borderColor: theme.colors.muted,
          }}>
          <Text
            style={{
              color: theme.colors.buttonText1,
              fontSize: fontScale(tokens.fontSize.sm),
              fontWeight: tokens.fontWeight.semiBold,
            }}>
            Next
          </Text>
        </TouchableOpacity>

        {/* Tweak */}
        <TouchableOpacity
          onPress={() => setShowTweakSheet(true)}
          style={{
            paddingHorizontal: moderateScale(tokens.spacing.md),
            paddingVertical: moderateScale(tokens.spacing.sm),
            borderRadius: tokens.borderRadius.sm,
            alignItems: 'center',
            backgroundColor: theme.colors.button1,
            // borderWidth: theme.borderWidth.hairline,
            // borderColor: theme.colors.muted,
          }}>
          <Icon name="tune" size={20} color={theme.colors.buttonText1} />
        </TouchableOpacity>
      </View>
    );
  };

  // Tweak constraint sheet overlay
  const TweakSheet = () => {
    const styleConstraints = [
      {label: 'More casual', value: 'more casual'},
      {label: 'More formal', value: 'more formal'},
      {label: 'Warmer layers', value: 'warmer layers'},
      {label: 'Cooler outfit', value: 'lighter, cooler'},
      {label: 'Different colors', value: 'different color palette'},
    ];

    // Get current outfit items for swap options
    const currentOutfit = getCurrentOutfit();
    const currentItems = currentOutfit?.items || [];

    // Category labels for display
    const categoryLabels: Record<string, string> = {
      top: 'Top',
      bottom: 'Bottom',
      outerwear: 'Outerwear',
      shoes: 'Shoes',
      accessory: 'Accessory',
    };

    // Get unique categories from current outfit for swap buttons
    const swappableCategories = [...new Set(currentItems.map(item => item.category))];

    if (!showTweakSheet) return null;

    return (
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 100,
        }}>
        {/* Backdrop */}
        <Pressable
          onPress={() => setShowTweakSheet(false)}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: theme.colors.i,
          }}
        />
        {/* Sheet */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            marginHorizontal: 16,
            backgroundColor: theme.colors.surface,
            borderRadius: tokens.borderRadius.xl,
            borderColor: theme.colors.muted,
            borderWidth: tokens.borderWidth.hairline,
            // borderTopLeftRadius: tokens.borderRadius.xl,
            // borderTopRightRadius: tokens.borderRadius.xl,
            padding: moderateScale(tokens.spacing.md),
            paddingBottom: moderateScale(tokens.spacing.xl),
            shadowColor: '#000',
            shadowOffset: {width: 0, height: -2},
            shadowOpacity: 0.2,
            shadowRadius: 12,
            elevation: 20,
          }}>
          {/* Single-Piece Swaps Section */}
          {swappableCategories.length > 0 && (
            <>
              <Text
                style={{
                  fontSize: fontScale(tokens.fontSize.lg),
                  fontWeight: tokens.fontWeight.bold,
                  color: theme.colors.foreground,
                  marginBottom: moderateScale(tokens.spacing.xs),
                }}>
                Swap one piece
              </Text>
              <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: moderateScale(tokens.spacing.md)}}>
                {swappableCategories.map(category => (
                  <TouchableOpacity
                    key={category}
                    onPress={() => {
                      // Map outfit category to wardrobe picker category
                      const categoryMap: Record<string, string> = {
                        top: 'Tops',
                        bottom: 'Bottoms',
                        outerwear: 'Outerwear',
                        shoes: 'Shoes',
                        accessory: 'Accessories',
                      };
                      setSwapPickerCategory(categoryMap[category] || 'All');
                      setSwappingCategory(category); // Track which outfit category to replace
                      setShowSwapPicker(true);
                    }}
                    style={{
                      backgroundColor: theme.colors.button1,
                      paddingHorizontal: moderateScale(tokens.spacing.md),
                      paddingVertical: moderateScale(tokens.spacing.xs),
                      borderRadius: tokens.borderRadius.md,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                    <Icon name="swap-horiz" size={16} color="#fff" />
                    <Text style={{color: '#fff', fontWeight: tokens.fontWeight.semiBold}}>
                      {categoryLabels[category] || category}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {/* Style Adjustments Section */}
          <Text
            style={{
              fontSize: fontScale(tokens.fontSize.md),
              fontWeight: tokens.fontWeight.semiBold,
              color: theme.colors.foreground2,
              marginBottom: moderateScale(tokens.spacing.xs),
            }}>
            Adjust Syling Choices
          </Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 8}}>
            {styleConstraints.map(c => (
              <TouchableOpacity
                key={c.value}
                onPress={() => {
                  setShowTweakSheet(false);
                  fetchSuggestion('tweak', c.value);
                }}
                style={{
                  backgroundColor: theme.colors.button1,
                  paddingHorizontal: moderateScale(tokens.spacing.sm),
                  paddingVertical: moderateScale(tokens.spacing.xs),
                  borderRadius: tokens.borderRadius.md,
                  borderWidth: theme.borderWidth.hairline,
                  borderColor: theme.colors.muted,
                }}>
                <Text style={{color: theme.colors.buttonText1, fontWeight: '500'}}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            onPress={() => setShowTweakSheet(false)}
            style={{
              marginTop: moderateScale(tokens.spacing.md),
              alignItems: 'center',
            }}>
            <Text style={{color: theme.colors.foreground2}}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const fetchSuggestion = async (
    _trigger: string = 'manual',
    constraint?: string,
  ) => {
    if (!weather?.fahrenheit?.main?.temp) {
      return;
    }

    // Prevent concurrent requests
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // Reset outfit index on new fetch
    setActiveOutfitIndex(0);

    try {
      setLoading(true);
      setError(null);

      // Get auth token for authenticated API call
      let accessToken: string | null = null;
      try {
        accessToken = await getAccessToken();
      } catch {
        // If no token, user is not authenticated
        setError('Please log in to get AI suggestions.');
        setLoading(false);
        return;
      }

      const payload = {
        user: userName,
        weather,
        wardrobe,
        preferences,
        format: 'visual', // Request new visual format
        mode: isAutoMode ? 'auto' : 'manual', // Mode affects phrasing
        ...(constraint && {constraint}), // Add tweak constraint if provided
      };

      const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Failed to fetch suggestion');
      let data: AiSuggestionData = normalizeStylistData(await res.json());

      // Refine shoe selections for color compatibility (Home Screen only)
      if ('outfits' in data && Array.isArray(data.outfits)) {
        data = refineOutfitShoes(data as any, wardrobe) as AiSuggestionData;
        console.log('[AIStylist] REFINED_OUTFITS', (data as any)?.outfits);
      }

      // 1️⃣ Update UI immediately
      setAiData(data);

      // 2️⃣ Persist suggestion AFTER render commit
      requestAnimationFrame(async () => {
        try {
          await AsyncStorage.setItem(
            AI_SUGGESTION_STORAGE_KEY,
            JSON.stringify({
              ...data,
              __cacheDate: new Date().toDateString(),
              __weatherTemp: weather?.fahrenheit?.main?.temp,
              __weatherCondition: (weather?.fahrenheit?.weather?.[0]?.main ?? '').toLowerCase(),
            }),
          );
        } catch (err) {
          // Failed to save AI suggestion
        }

        // 3️⃣ Guaranteed repaint tick (forces text paint but keeps data stable)
        setTimeout(() => {
          setAiData(prev => (prev ? {...prev} : null));
        }, 25);
      });

      // 4️⃣ Notifications + cooldown
      const now = Date.now();
      // Get summary text for notification (works for both formats)
      const summaryText = isVisualFormat(data)
        ? data.outfits[0]?.summary || 'New outfit suggestions ready'
        : data.suggestion || 'New style recommendation';
      const significantChange =
        lastSuggestionRef.current &&
        summaryText &&
        summaryText.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

      if (
        significantChange &&
        now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
      ) {
        PushNotification.localNotification({
          title: '✨ New Style Suggestion Ready',
          message: summaryText,
          channelId: 'ai-suggestions',
        });
        lastNotifyTimeRef.current = now;

        // 🏝️ Show in Dynamic Island
        (async () => {
          try {
            const diEnabled = await DynamicIsland.isEnabled();
            if (diEnabled) {
              await DynamicIsland.start(
                '✨ New Style Suggestion',
                summaryText,
              );
              // Auto-dismiss after 15 seconds
              setTimeout(async () => {
                try {
                  await DynamicIsland.end();
                } catch {}
              }, 15000);
            }
          } catch {}
        })();
      }

      lastSuggestionRef.current = summaryText;
      lastFetchTimeRef.current = now;

      // 5️⃣ Persist fetch time
      await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
    } catch (err) {
      setError('Unable to load AI suggestions right now.');
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  // Set ref so useEffect can call fetchSuggestion
  fetchSuggestionRef.current = fetchSuggestion;

  /** 🔄 Swap single item - keeps UI visible, only shows spinner on swapped category */
  const swapSingleItem = async (category: string, keepIds: string[]) => {
    if (!weather?.fahrenheit?.main?.temp) {
      setSwappingCategory(null);
      return;
    }

    // Prevent concurrent requests (shared guard with fetchSuggestion)
    if (inFlightRef.current) {
      setSwappingCategory(null);
      return;
    }
    inFlightRef.current = true;

    try {
      // Don't set loading - keep current UI visible
      // swappingCategory is already set by caller

      let accessToken: string | null = null;
      try {
        accessToken = await getAccessToken();
      } catch {
        setSwappingCategory(null);
        return;
      }

      const payload = {
        user: userName,
        weather,
        wardrobe,
        preferences,
        format: 'visual',
        mode: isAutoMode ? 'auto' : 'manual', // Mode affects phrasing
        constraint: `swap ${category} only, keep these items: ${keepIds.join(', ')}`,
      };

      const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Failed to swap item');
      let data: AiSuggestionData = normalizeStylistData(await res.json());

      // Refine shoe selections for color compatibility (Home Screen only)
      if ('outfits' in data && Array.isArray(data.outfits)) {
        data = refineOutfitShoes(data as any, wardrobe) as AiSuggestionData;
        console.log('[AIStylist] REFINED_OUTFITS_SWAP', (data as any)?.outfits);
      }

      // Emit learning signal for tweak/constraint
      emitHomeSignal('STYLE_CONSTRAINT_SIGNAL', undefined, {
        tags: [`swap ${category}`],
        categories: [category],
      });

      // Update UI with new data
      setAiData(data);
      setActiveOutfitIndex(0);

      // Persist with cache metadata (must match fetchSuggestion format for restore validity)
      requestAnimationFrame(async () => {
        try {
          await AsyncStorage.setItem(
            AI_SUGGESTION_STORAGE_KEY,
            JSON.stringify({
              ...data,
              __cacheDate: new Date().toDateString(),
              __weatherTemp: weather?.fahrenheit?.main?.temp,
              __weatherCondition: (weather?.fahrenheit?.weather?.[0]?.main ?? '').toLowerCase(),
            }),
          );
        } catch {}
      });
    } catch (err) {
      console.error('Swap failed:', err);
    } finally {
      inFlightRef.current = false;
      setSwappingCategory(null); // Clear spinner
    }
  };

  // Set ref so TweakSheet can call swapSingleItem
  swapSingleItemRef.current = swapSingleItem;

  /** 📍 Fallback suggestion */
  const fallbackSuggestion = () => {
    const temp = weather?.fahrenheit?.main?.temp;
    const condition = weather?.celsius?.weather?.[0]?.main;

    if (!temp)
      return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

    let base = '';
    if (temp < 40)
      base =
        'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
    else if (temp < 50)
      base =
        'Chilly — add mid-weight layers like knitwear or light outer layers.';
    else if (temp < 65)
      base =
        'Mild — lightweight layers and versatile pieces will keep you ready.';
    else if (temp < 80)
      base =
        'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
    else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
    else
      base =
        'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

    let extra = '';
    if (condition === 'Rain')
      extra = ' ☔ Waterproof layers will keep you dry.';
    if (condition === 'Snow')
      extra = ' ❄️ Choose insulated footwear and outerwear.';
    if (condition === 'Clear')
      extra = ' 😎 Sunglasses add both comfort and style.';
    if (condition === 'Clouds')
      extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

    return `${base}${extra}`;
  };

  /** 📊 Load saved auto-mode preference */
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === null) {
          setIsAutoMode(false);
          await AsyncStorage.setItem(STORAGE_KEY, 'false');
        } else {
          setIsAutoMode(saved === 'true');
        }
      } catch (e) {
        console.warn('⚠️ Failed to load auto mode setting', e);
        setIsAutoMode(false);
      }
    })();
  }, []);

  /** ✅ Restore last saved AI suggestion AND active outfit index on mount */
  useEffect(() => {
    (async () => {
      try {
        const [savedSuggestion, savedIndex] = await Promise.all([
          AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY),
          AsyncStorage.getItem(AI_ACTIVE_OUTFIT_INDEX_KEY),
        ]);

        if (savedSuggestion) {
          const parsed = JSON.parse(savedSuggestion);

          // 🗓️ Daily invalidation: ignore cache from previous days
          const isStaleDate = parsed?.__cacheDate && parsed.__cacheDate !== new Date().toDateString();

          // 🌡️ Weather delta invalidation
          const currentTemp = weather?.fahrenheit?.main?.temp;
          const cachedTemp = parsed?.__weatherTemp;
          const isStaleWeather = currentTemp != null && cachedTemp != null && Math.abs(currentTemp - cachedTemp) > 15;

          if (!isStaleDate && !isStaleWeather) {
            let restored: AiSuggestionData = normalizeStylistData(parsed);
            // Re-refine cached data with current wardrobe (cache may predate latest rules)
            if ('outfits' in restored && Array.isArray((restored as any).outfits) && wardrobe.length > 0) {
              restored = refineOutfitShoes(restored as any, wardrobe) as AiSuggestionData;
            }
            setAiData(restored);

            // restore refs for cooldown checks
            if (parsed?.suggestion) {
              lastSuggestionRef.current = parsed.suggestion;
            }
          }
        }

        // Restore active outfit index
        if (savedIndex !== null) {
          const idx = parseInt(savedIndex, 10);
          if (!isNaN(idx) && idx >= 0) {
            setActiveOutfitIndex(idx);
          }
        }
      } catch (err) {
        console.warn('⚠️ Failed to load saved AI suggestion', err);
      }
    })();
  }, []);

  /** ✅ Restore last fetch timestamp */
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
        if (stored) lastFetchTimeRef.current = Number(stored);
      } catch (err) {
        console.warn('⚠️ Failed to load last fetch time', err);
      }
    })();
  }, []);

  /** ✅ Load expanded state from persistent storage */
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(AI_SUGGESTION_EXPANDED_KEY);
        if (saved === null) {
          setIsExpanded(true);
          await AsyncStorage.setItem(AI_SUGGESTION_EXPANDED_KEY, 'true');
        } else {
          setIsExpanded(saved === 'true');
        }
      } catch (err) {
        console.warn('⚠️ Failed to load expanded state', err);
        setIsExpanded(true);
      }
    })();
  }, []);

  /** 💾 Save auto-mode preference */
  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
      console.warn('⚠️ Failed to save auto mode setting', e),
    );
  }, [isAutoMode]);

  /** 💾 Save expanded state whenever it changes */
  useEffect(() => {
    AsyncStorage.setItem(
      AI_SUGGESTION_EXPANDED_KEY,
      isExpanded.toString(),
    ).catch(e => console.warn('⚠️ Failed to save expanded state', e));
  }, [isExpanded]);

  /** 💾 Save active outfit index whenever it changes */
  useEffect(() => {
    AsyncStorage.setItem(
      AI_ACTIVE_OUTFIT_INDEX_KEY,
      activeOutfitIndex.toString(),
    ).catch(e => console.warn('⚠️ Failed to save active outfit index', e));
  }, [activeOutfitIndex]);

  /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
  useEffect(() => {
    if (!isAutoMode) return;

    const runAutoCheck = async () => {
      const now = Date.now();
      const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

      try {
        const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
        const parsed = saved ? JSON.parse(saved) : null;

        // Check if we have valid cached data (works for both formats)
        const hasValidCache =
          (parsed?.suggestion && isTextFormat(parsed)) ||
          (parsed?.outfits && isVisualFormat(parsed));

        // 🗓️ Daily invalidation
        const isStaleDate = parsed?.__cacheDate && parsed.__cacheDate !== new Date().toDateString();

        // 🌡️ Weather delta invalidation
        const currentTemp = weather?.fahrenheit?.main?.temp;
        const cachedTemp = parsed?.__weatherTemp;
        const isStaleWeather = currentTemp != null && cachedTemp != null && Math.abs(currentTemp - cachedTemp) > 15;

        // 🌧️ Weather condition change invalidation (e.g. sunny → rain at same temp)
        const currentCondition = (weather?.fahrenheit?.weather?.[0]?.main ?? '').toLowerCase();
        const cachedCondition = (parsed?.__weatherCondition ?? '').toLowerCase();
        const isStaleCondition = currentCondition && cachedCondition && currentCondition !== cachedCondition;

        // ✅  Only fetch if nothing saved OR cooldown expired OR date/weather stale
        if (!hasValidCache || cooldownPassed || isStaleDate || isStaleWeather || isStaleCondition) {
          fetchSuggestion('initial');
          lastFetchTimeRef.current = now;
        } else {
          let restored: AiSuggestionData = normalizeStylistData(parsed);
          // Re-refine cached data with current wardrobe (cache may predate latest rules)
          if ('outfits' in restored && Array.isArray((restored as any).outfits) && wardrobe.length > 0) {
            restored = refineOutfitShoes(restored as any, wardrobe) as AiSuggestionData;
          }
          setAiData(restored);
          // Update ref with summary text for both formats
          const summaryText = isVisualFormat(restored)
            ? parsed.outfits[0]?.summary
            : parsed.suggestion;
          if (summaryText) {
            lastSuggestionRef.current = summaryText;
          }
        }
      } catch (err) {
        console.warn('⚠️ Failed to check auto mode cache', err);
        fetchSuggestion('initial');
        lastFetchTimeRef.current = now;
      }
    };

    runAutoCheck();
  }, [isAutoMode]);

  /** 🔁 Auto-refresh every 4h */
  useEffect(() => {
    if (isAutoMode) {
      refreshTimerRef.current = setInterval(() => {
        fetchSuggestion('scheduled');
      }, NOTIFICATION_COOLDOWN_MS);
    }
    return () =>
      refreshTimerRef.current && clearInterval(refreshTimerRef.current);
  }, [isAutoMode]);

  /** 🔄 Refresh when app resumes */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (isAutoMode && state === 'active') {
        const now = Date.now();
        if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
          fetchSuggestion('resume');
          lastFetchTimeRef.current = now;
        }
      }
    });
    return () => subscription.remove();
  }, [isAutoMode]);

  return (
    <SafeAreaView
      edges={['left', 'right']} // ✅ disables top & bottom padding
      style={{flex: 1}}>

      <ScrollView
        ref={containerRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[globalStyles.section7, {marginTop: 6}]}>
        <Animatable.View
          animation="fadeInUp"
          delay={200}
          duration={700}
          useNativeDriver
          style={[
            globalStyles.cardStyles6,
            {
              // backgroundColor: theme.colors.surface,
              // borderWidth: theme.borderWidth.hairline,
              // borderColor: theme.colors.button1,
              // padding: moderateScale(tokens.spacing.md1),
            },
          ]}>
          {/* 🧠 Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: 10
              // marginBottom: moderateScale(tokens.spacing.xxs),
            }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 13,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                marginRight: moderateScale(tokens.spacing.xs),
              }}>
              <Image
                source={require('../../assets/images/Styla1.png')}
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: 13,
                  resizeMode: 'cover',
                }}
              />
            </View>

            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: fontScale(tokens.fontSize.lg),
                fontWeight: tokens.fontWeight.bold,
                color: theme.colors.foreground,
                textTransform: 'uppercase',
              }}>
             What to Wear Today
            </Text>

          </View>

          {/* 💬 Suggestion Card ( c zone) */}
          <SwipeableCard
            onSwipeLeft={() => {
              const dismissed = getCurrentOutfit();
              if (dismissed) {
                emitHomeSignal(
                  'ITEM_EXPLICITLY_DISMISSED',
                  dismissed.id,
                  buildOutfitFeatures(dismissed.items),
                );
              }
              fetchSuggestion('manual');
            }}
            onSwipeRight={() => {
              const currentOutfit = getCurrentOutfit();
              navigate('Outfit', {
                from: 'AiStylistSuggestions',
                seedPrompt:
                  currentOutfit?.summary ||
                  (isTextFormat(aiData) ? aiData?.suggestion : null) ||
                  fallbackSuggestion(),
                preselectedItems: currentOutfit?.items,
                autogenerate: true,
              });
            }}
            deleteThreshold={0.08}
            style={{
              // backgroundColor: theme.colors.surface2,
              borderRadius: tokens.borderRadius.xl,
              // borderWidth: theme.borderWidth.hairline,
              // borderColor: theme.colors.muted,
              paddingHorizontal: moderateScale(tokens.spacing.md),
              //  paddingVertical: moderateScale(tokens.spacing.sm),
            }}>
            {loading && (
              <ActivityIndicator
                color={theme.colors.button1}
                style={{marginVertical: moderateScale(tokens.spacing.md2)}}
              />
            )}

            {/* ✨ NEW: Visual outfit format */}
            {!loading && aiData && isVisualFormat(aiData) && (
              <>
                {/* Weather Summary - one line */}
                {aiData.weatherSummary && (
                  <Text
                    style={{
                      fontSize: fontScale(tokens.fontSize.xs),
                      color: theme.colors.foreground2,
                      marginBottom: moderateScale(tokens.spacing.xs),
                      // paddingHorizontal: moderateScale(tokens.spacing.xxs),
                    }}>
                    {aiData.weatherSummary}
                  </Text>
                )}

                {/* Rank Badge — deterministic from array position */}
                {getCurrentOutfit() && activeOutfitIndex < 3 && (
                  <RankBadge rank={(activeOutfitIndex + 1) as 1 | 2 | 3} />
                )}

                {/* Visual Outfit Strip - IMAGES FIRST */}
                <OutfitStrip items={getCurrentOutfit()?.items || []} outfitIndex={activeOutfitIndex} />

                {/* Outfit Title — under the image */}
                <Text
                  style={{
                    fontSize: fontScale(tokens.fontSize.md),
                    fontWeight: tokens.fontWeight.semiBold,
                    color: theme.colors.foreground,
                    textAlign: 'center',
                    // lineHeight: 22,
                    // marginTop: moderateScale(tokens.spacing.xs),
                    // marginBottom: moderateScale(tokens.spacing.xs),
                    paddingHorizontal: moderateScale(tokens.spacing.xxs),
                  }}
                  numberOfLines={1}>
                  {(getCurrentOutfit() as any)?.title ?? (getCurrentOutfit() as any)?.name ?? 'Outfit'}
                </Text>

                {/* Action Buttons */}
                <ActionButtons />

              </>
            )}

            {/* 📝 LEGACY: Text-based format (backward compatibility) */}
            {!loading && aiData && isTextFormat(aiData) && (
              <>
                <Animatable.View
                  key={aiData.suggestion?.slice(0, 60) || 'empty'}
                  animation="fadeIn"
                  duration={250}
                  useNativeDriver
                  style={{
                    opacity: 1,
                    overflow: 'hidden',
                    maxHeight: isExpanded ? 1000 : 150,
                  }}>
                  <Text
                    style={{
                      fontSize: fontScale(tokens.fontSize.md),
                      fontWeight: tokens.fontWeight.semiBold,
                      color: theme.colors.foreground,
                      lineHeight: 22,
                      marginBottom: moderateScale(tokens.spacing.md),
                      paddingHorizontal: moderateScale(tokens.spacing.xxs),
                    }}>
                    {error ? fallbackSuggestion() : aiData.suggestion}
                  </Text>

                  {aiData.insight && (
                    <Animatable.Text
                      animation="fadeIn"
                      delay={300}
                      style={{
                        fontSize: fontScale(tokens.fontSize.md),
                        color: theme.colors.foreground2,
                        fontStyle: 'italic',
                        marginBottom: moderateScale(tokens.spacing.sm2),
                        lineHeight: 20,
                        marginHorizontal: moderateScale(tokens.spacing.md),
                      }}>
                      {aiData.insight}
                    </Animatable.Text>
                  )}

                  {aiData.tomorrow && (
                    <Animatable.Text
                      animation="fadeInUp"
                      delay={400}
                      style={{
                        fontSize: fontScale(tokens.fontSize.md),
                        color: theme.colors.foreground2,
                        marginBottom: moderateScale(tokens.spacing.md1),
                        lineHeight: 20,
                        marginHorizontal: moderateScale(tokens.spacing.md),
                      }}>
                      Tomorrow: {aiData.tomorrow}
                    </Animatable.Text>
                  )}

                  {aiData.seasonalForecast && (
                    <Animatable.Text
                      animation="fadeInUp"
                      delay={500}
                      style={{
                        fontSize: fontScale(tokens.fontSize.md),
                        color: theme.colors.foreground2,
                        marginBottom: moderateScale(tokens.spacing.md1),
                        lineHeight: 20,
                        marginHorizontal: moderateScale(tokens.spacing.md),
                      }}>
                      {aiData.seasonalForecast}
                    </Animatable.Text>
                  )}

                  {aiData.lifecycleForecast && (
                    <Animatable.Text
                      animation="fadeInUp"
                      delay={600}
                      style={{
                        fontSize: fontScale(tokens.fontSize.md),
                        color: theme.colors.foreground2,
                        marginBottom: moderateScale(tokens.spacing.md1),
                        lineHeight: 20,
                        marginHorizontal: moderateScale(tokens.spacing.md),
                      }}>
                      {aiData.lifecycleForecast}
                    </Animatable.Text>
                  )}

                  {aiData.styleTrajectory && (
                    <Animatable.Text
                      animation="fadeInUp"
                      delay={700}
                      style={{
                        fontSize: fontScale(tokens.fontSize.md),
                        color: theme.colors.foreground2,
                        marginBottom: moderateScale(tokens.spacing.md1),
                        lineHeight: 20,
                        marginHorizontal: moderateScale(tokens.spacing.md),
                      }}>
                      {aiData.styleTrajectory}
                    </Animatable.Text>
                  )}
                </Animatable.View>

                {/* Collapse / Expand toggle for text format */}
                <Pressable
                  onPress={toggleExpanded}
                  style={{
                    alignItems: 'center',
                    paddingVertical: moderateScale(tokens.spacing.xsm),
                    flexDirection: 'row',
                    justifyContent: 'center',
                  }}>
                  <Text
                    style={{
                      color: theme.colors.button1,
                      fontSize: fontScale(tokens.fontSize.base),
                      marginRight: moderateScale(tokens.spacing.xxs),
                    }}>
                    {isExpanded ? 'Show Less' : 'Show More'}
                  </Text>
                  <Animatable.View
                    duration={250}
                    style={{
                      transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
                    }}>
                    <Icon
                      name="expand-more"
                      size={24}
                      color={theme.colors.button1}
                    />
                  </Animatable.View>
                </Pressable>
              </>
            )}

            {/* Fallback when no data */}
            {!loading && !aiData && (
              <Text
                style={{
                  fontSize: fontScale(tokens.fontSize.md),
                  fontWeight: tokens.fontWeight.semiBold,
                  color: theme.colors.foreground,
                  lineHeight: 22,
                  marginBottom: moderateScale(tokens.spacing.md),
                  paddingHorizontal: moderateScale(tokens.spacing.xxs),
                }}>
                {fallbackSuggestion()}
              </Text>
            )}
          </SwipeableCard>

          {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
          <View
            style={{
              flexDirection:
                isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
              justifyContent: 'center',
              alignItems: 'center',
              marginTop: moderateScale(tokens.spacing.md1),
              width: '100%',
            }}>
     
          </View>
        </Animatable.View>
      </ScrollView>

      {/* 🎛️ Tweak Sheet Overlay - at SafeAreaView level for proper positioning */}
      <TweakSheet />

      {/* 🖼️ Full Screen Outfit Modal */}
      <Modal
        visible={fullScreenOutfitIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFullScreenOutfitIndex(null)}>
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.background,
          }}>
          {/* Close button */}
          <TouchableOpacity
            onPress={() => setFullScreenOutfitIndex(null)}
            style={{
              position: 'absolute',
              top: 60,
              right: 20,
              zIndex: 10,
              padding: 6,
              backgroundColor: 'white',
              borderColor: 'black',
              borderWidth: tokens.borderWidth.hairline,
              borderRadius: 50
            }}>
            <Icon name="close" size={22} color="black" />
          </TouchableOpacity>

          <ScrollView
            contentContainerStyle={{
              alignItems: 'center',
              paddingTop: 100,
              paddingBottom: 40,
            }}
            showsVerticalScrollIndicator={false}>
          {/* Full screen snapshot layout - centered with rank and summary */}
          {(() => {
            const outfits = isVisualFormat(aiData) ? aiData.outfits : [];
            const totalOutfits = outfits.length;
            const currentOutfit = outfits[fullScreenOutfitIndex ?? 0];
            const __fsRank = ((fullScreenOutfitIndex ?? 0) + 1) as 1 | 2 | 3;
            const items = ensureExecutiveCompleteness(currentOutfit?.items || []);
            const topItem = items.find(i => i.category === 'top');
            const outerwearItem = items.find(i => i.category === 'outerwear');
            const bottomItem = items.find(i => i.category === 'bottom');
            const shoesItem = items.find(i => i.category === 'shoes');
            const accessoryItems = items.filter(i => i.category === 'accessory');
            const screenWidth = Dimensions.get('window').width;

            const rankLabels: Record<1 | 2 | 3, string> = {
              1: '1st Pick',
              2: '2nd Pick',
              3: '3rd Pick',
            };

            // Navigation functions - wrap around continuously
            const goToPrev = () => {
              if (fullScreenOutfitIndex !== null && totalOutfits > 0) {
                const newIndex = fullScreenOutfitIndex === 0 ? totalOutfits - 1 : fullScreenOutfitIndex - 1;
                setFullScreenOutfitIndex(newIndex);
              }
            };

            const goToNext = () => {
              if (fullScreenOutfitIndex !== null && totalOutfits > 0) {
                const newIndex = fullScreenOutfitIndex === totalOutfits - 1 ? 0 : fullScreenOutfitIndex + 1;
                setFullScreenOutfitIndex(newIndex);
              }
            };

            const showArrows = totalOutfits > 1;

            return (
              <View style={{alignItems: 'center', width: '100%'}}>
                {/* Rank Badge — deterministic from array position */}
                {(fullScreenOutfitIndex ?? 0) < 3 && (
                <View
                  style={{
                    backgroundColor: __fsRank === 1 ? theme.colors.button1 : __fsRank === 2 ? theme.colors.foreground2 : theme.colors.muted,
                    paddingHorizontal: 16,
                    paddingVertical: 6,
                    borderRadius: 20,
                    marginBottom: 12,
                  }}>
                  <Text style={{color: __fsRank === 1 ? '#fff' : theme.colors.buttonText1, fontSize: 16, fontWeight: '600'}}>
                    {rankLabels[__fsRank]}
                  </Text>
                </View>
                )}

                {/* Outfit Title */}
                <Text style={{color: theme.colors.foreground, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 16, paddingHorizontal: 32}} numberOfLines={1}>
                  {(currentOutfit as any)?.title ?? (currentOutfit as any)?.name ?? 'Outfit'}
                </Text>

                {/* Outfit Card with arrows inside */}
                <View
                  style={{
                    width: screenWidth - 16,
                    borderRadius: tokens.borderRadius.switch1,
                    backgroundColor: theme.colors.imageBackground,
                    flexDirection: 'row',
                    paddingVertical: 12,
                    alignItems: 'center',
                }}>
                  {/* Left Arrow */}
                  <TouchableOpacity
                    onPress={goToPrev}
                    style={{padding: 4, opacity: showArrows ? 1 : 0.3}}>
                    <Icon name="chevron-left" size={28} color={theme.colors.muted} />
                  </TouchableOpacity>

                  {/* Left column: Outerwear */}
                  <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8, }}>
                    {outerwearItem && (
                      <Image
                        source={{uri: outerwearItem.imageUrl}}
                        style={{width: 160, height: 160}}
                        resizeMode="contain"
                      />
                    )}
                  </View>

                  {/* Center column: Top → Bottom → Shoes (overlapping) */}
                  <View style={{flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 6}}>
                    {topItem && (
                      <Image
                        source={{uri: topItem.imageUrl}}
                        style={{width: 200, height: 200, zIndex: 3}}
                        resizeMode="contain"
                      />
                    )}
                    {bottomItem && (
                      <Image
                        source={{uri: bottomItem.imageUrl}}
                        style={{width: 220, height: 220, marginTop: -22, zIndex: 2}}
                        resizeMode="contain"
                      />
                    )}
                    {shoesItem && (
                      <Image
                        source={{uri: shoesItem.imageUrl}}
                        style={{width: 110, height: 110,
                          marginTop: -25, marginRight: 30, zIndex: 1}}
                        resizeMode="contain"
                      />
                    )}
                  </View>

                  {/* Right column: Accessories */}
                  <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8, gap: 10}}>
                    {accessoryItems.map((acc, idx) => (
                      <Image
                        key={`${acc.id}-${idx}`}
                        source={{uri: acc.imageUrl}}
                        style={{width: 160, height: 160, marginRight: 10}}
                        resizeMode="contain"
                      />
                    ))}
                  </View>

                  {/* Right Arrow */}
                  <TouchableOpacity
                    onPress={goToNext}
                    style={{padding: 4, opacity: showArrows ? 1 : 0.3}}>
                    <Icon name="chevron-right" size={28} color={theme.colors.muted} />
                  </TouchableOpacity>
                </View>


                {/* Individual Items Grid */}
                <View style={{
                  width: screenWidth - 48,
                  marginTop: 24,
                }}>
                  <Text style={{color: theme.colors.foreground, fontSize: 14, fontWeight: '600', marginBottom: 12, opacity: 0.7}}>
                    Items in this outfit
                  </Text>
                  <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 4}}>
                    {items.map((item, idx) => (
                      <View
                        key={`${item.id}-${idx}`}
                        style={{
                          width: (screenWidth - 52) / 2,
                          height: (screenWidth - 0) / 2,
                          borderRadius: tokens.borderRadius.switch1,
                          overflow: 'hidden',
                        }}>
                        <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', padding: 10, backgroundColor: theme.colors.imageBackground}}>
                          <Image
                            source={{uri: item.imageUrl}}
                            style={{width: 150, height: 150,}}
                            resizeMode="contain"
                          />
                        </View>
                        <View style={{paddingVertical: 8, paddingBottom: 8}}>
                          <Text
                            style={globalStyles.label}
                            numberOfLines={1}>
                            {item.name}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>

                {/* Outfit Description — always render under images */}
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    fontWeight: '400',
                    textAlign: 'center',
                    marginTop: 20,
                    paddingHorizontal: 24,
                    opacity: 0.85,
                    lineHeight: 20,
                  }}>
                  {currentOutfit?.summary ?? ' '}
                </Text>
              </View>
            );
          })()}
          </ScrollView>
        </View>
      </Modal>

      {/* Wardrobe Picker Modal for swapping items */}
      <WardrobePickerModal
        visible={showSwapPicker}
        onClose={() => {
          setShowSwapPicker(false);
          setSwappingCategory(null);
          setSwapPickerCategory(null);
        }}
        onSelectItem={handleSwapItem}
        defaultCategory={swapPickerCategory || undefined}
      />

      {/* Hidden ViewShot for capturing outfit snapshot */}
      <View style={{position: 'absolute', left: -9999, top: -9999}}>
        <ViewShot
          ref={snapshotRef}
          options={{format: 'png', quality: 0.9}}
          style={{
            width: 165,
            height: 240,
            backgroundColor: theme.colors.imageBackground,
            flexDirection: 'row',
          }}>
          {(() => {
            const outfit = getCurrentOutfit();
            if (!outfit) return null;
            const items = ensureExecutiveCompleteness(outfit.items || []);
            const topItem = items.find(i => i.category === 'top');
            const outerwearItem = items.find(i => i.category === 'outerwear');
            const bottomItem = items.find(i => i.category === 'bottom');
            const shoesItem = items.find(i => i.category === 'shoes');
            const accessoryItems = items.filter(i => i.category === 'accessory');

            return (
              <>
                {/* Left column: Outerwear */}
                <View style={{width: 50, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 12}}>
                  {outerwearItem?.imageUrl && (
                    <FastImage
                      source={{uri: outerwearItem.imageUrl}}
                      style={{width: 50, height: 50}}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  )}
                </View>

                {/* Center column: Top → Bottom → Shoes (overlapping) */}
                <View style={{flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 10}}>
                  {topItem?.imageUrl && (
                    <FastImage
                      source={{uri: topItem.imageUrl}}
                      style={{width: 95, height: 95, zIndex: 3}}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  )}
                  {bottomItem?.imageUrl && (
                    <FastImage
                      source={{uri: bottomItem.imageUrl}}
                      style={{width: 95, height: 95, marginTop: -10, zIndex: 2}}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  )}
                  {shoesItem?.imageUrl && (
                    <FastImage
                      source={{uri: shoesItem.imageUrl}}
                      style={{width: 50, height: 50, marginTop: -10, zIndex: 1}}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  )}
                </View>

                {/* Right column: Accessories */}
                <View style={{width: 50, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 12, gap: 8}}>
                  {accessoryItems.map((acc, idx) => (
                    <FastImage
                      key={`${acc.id}-${idx}`}
                      source={{uri: acc.imageUrl}}
                      style={{width: 50, height: 50, marginTop: 80}}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  ))}
                </View>
              </>
            );
          })()}
        </ViewShot>
      </View>
    </SafeAreaView>
  );
};

export default AiStylistSuggestions;

////////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
//   Image,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {findNodeHandle, UIManager} from 'react-native';
// import {DynamicIsland} from '../../native/dynamicIsland';
// import {getAccessToken} from '../../utils/auth';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// // ✅ Persistent expanded state key
// const AI_SUGGESTION_EXPANDED_KEY = 'aiStylist_isExpanded';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const containerRef = useRef<View>(null);

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true); // Default to expanded
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   const scrollRef = useRef<ScrollView>(null);

//   const fetchSuggestion = async (_trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       // Get auth token for authenticated API call
//       let accessToken: string | null = null;
//       try {
//         accessToken = await getAccessToken();
//       } catch {
//         // If no token, user is not authenticated
//         setError('Please log in to get AI suggestions.');
//         setLoading(false);
//         return;
//       }

//       const payload = {user: userName, weather, wardrobe, preferences};

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           Authorization: `Bearer ${accessToken}`,
//         },
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();

//       // 1️⃣ Update UI immediately
//       setAiData(data);

//       // 2️⃣ Persist suggestion AFTER render commit
//       requestAnimationFrame(async () => {
//         try {
//           await AsyncStorage.setItem(
//             AI_SUGGESTION_STORAGE_KEY,
//             JSON.stringify(data),
//           );
//         } catch (err) {
//           // Failed to save AI suggestion
//         }

//         // 3️⃣ Guaranteed repaint tick (forces text paint but keeps data stable)
//         setTimeout(() => {
//           setAiData(prev => ({...prev}));
//         }, 25);
//       });

//       // 4️⃣ Notifications + cooldown
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;

//         // 🏝️ Show in Dynamic Island
//         (async () => {
//           try {
//             const diEnabled = await DynamicIsland.isEnabled();
//             if (diEnabled) {
//               await DynamicIsland.start(
//                 '✨ New Style Suggestion',
//                 data.suggestion,
//               );
//               // Auto-dismiss after 15 seconds
//               setTimeout(async () => {
//                 try {
//                   await DynamicIsland.end();
//                 } catch {}
//               }, 15000);
//             }
//           } catch {}
//         })();
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;

//       // 5️⃣ Persist fetch time
//       await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//     } catch (err) {
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last fetch timestamp */
//   useEffect(() => {
//     (async () => {
//       try {
//         const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
//         if (stored) lastFetchTimeRef.current = Number(stored);
//       } catch (err) {
//         console.warn('⚠️ Failed to load last fetch time', err);
//       }
//     })();
//   }, []);

//   /** ✅ Load expanded state from persistent storage */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_EXPANDED_KEY);
//         if (saved === null) {
//           setIsExpanded(true);
//           await AsyncStorage.setItem(AI_SUGGESTION_EXPANDED_KEY, 'true');
//         } else {
//           setIsExpanded(saved === 'true');
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load expanded state', err);
//         setIsExpanded(true);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 💾 Save expanded state whenever it changes */
//   useEffect(() => {
//     AsyncStorage.setItem(
//       AI_SUGGESTION_EXPANDED_KEY,
//       isExpanded.toString(),
//     ).catch(e => console.warn('⚠️ Failed to save expanded state', e));
//   }, [isExpanded]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
//   useEffect(() => {
//     if (!isAutoMode) return;

//     const runAutoCheck = async () => {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         const parsed = saved ? JSON.parse(saved) : null;

//         // ✅  Only fetch if nothing saved OR cooldown expired
//         if (!parsed?.suggestion || cooldownPassed) {
//           fetchSuggestion('initial');
//           lastFetchTimeRef.current = now;
//         } else {
//           setAiData(parsed);
//           lastSuggestionRef.current = parsed.suggestion;
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to check auto mode cache', err);
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     };

//     runAutoCheck();
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         ref={containerRef}
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <View
//               style={{
//                 width: 40,
//                 height: 40,
//                 borderRadius: 13,
//                 overflow: 'hidden',
//                 borderWidth: 1,
//                 borderColor: theme.colors.surfaceBorder,
//                 marginRight: moderateScale(tokens.spacing.xs),
//               }}>
//               <Image
//                 source={require('../../assets/images/Styla1.png')}
//                 style={{
//                   width: '100%',
//                   height: '100%',
//                   borderRadius: 13,
//                   resizeMode: 'cover',
//                 }}
//               />
//             </View>

//             <Text
//               numberOfLines={1}
//               style={{
//                 flex: 1,
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Styla's Suggestions
//             </Text>

//             {/* Status dot: pulsing green when Auto, grey outline when Manual */}
//             {isAutoMode ? (
//               <Animatable.View
//                 animation={{
//                   0: {scale: 1, opacity: 0.7},
//                   0.5: {scale: 1.3, opacity: 1},
//                   1: {scale: 1, opacity: 0.7},
//                 }}
//                 iterationCount="infinite"
//                 duration={1500}
//                 easing="ease-in-out"
//                 useNativeDriver
//                 style={{
//                   width: 8,
//                   height: 8,
//                   borderRadius: 4,
//                   backgroundColor: '#34C759',
//                   marginLeft: moderateScale(tokens.spacing.xs),
//                 }}
//               />
//             ) : (
//               <View
//                 style={{
//                   width: 8,
//                   height: 8,
//                   borderRadius: 4,
//                   borderWidth: 1.5,
//                   borderColor: theme.colors.muted,
//                   backgroundColor: 'transparent',
//                   marginLeft: moderateScale(tokens.spacing.xs),
//                 }}
//               />
//             )}
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 // fontSize: fontScale(tokens.fontSize.sm),
//                 fontSize: fontScale(tokens.fontSize.base),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{
//                 false: theme.colors.muted,
//                 true: theme.colors.button1,
//               }}
//               ios_backgroundColor={theme.colors.muted}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   key={aiData?.suggestion?.slice(0, 60) || 'empty'}
//                   animation="fadeIn"
//                   duration={250}
//                   useNativeDriver
//                   style={{
//                     opacity: 1, // keep visible
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150,
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       // fontWeight: tokens.fontWeight.semiBold,
//                       // fontSize: fontScale(tokens.fontSize.md),
//                       fontSize: fontScale(tokens.fontSize.base),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//               marginBottom: -22
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.md),
//               }}>
//               Swipe card above for new suggestion
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
     
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

///////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
//   Image,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {findNodeHandle, UIManager} from 'react-native';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// // ✅ Persistent expanded state key
// const AI_SUGGESTION_EXPANDED_KEY = 'aiStylist_isExpanded';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const containerRef = useRef<View>(null);

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true); // Default to expanded
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   const scrollRef = useRef<ScrollView>(null);

//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();

//       // 1️⃣ Update UI immediately
//       setAiData(data);

//       // 2️⃣ Persist suggestion AFTER render commit
//       requestAnimationFrame(async () => {
//         try {
//           await AsyncStorage.setItem(
//             AI_SUGGESTION_STORAGE_KEY,
//             JSON.stringify(data),
//           );
//         } catch (err) {
//           // Failed to save AI suggestion
//         }

//         // 3️⃣ Guaranteed repaint tick (forces text paint but keeps data stable)
//         setTimeout(() => {
//           setAiData(prev => ({...prev}));
//         }, 25);
//       });

//       // 4️⃣ Notifications + cooldown
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;

//       // 5️⃣ Persist fetch time
//       await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//     } catch (err) {
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last fetch timestamp */
//   useEffect(() => {
//     (async () => {
//       try {
//         const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
//         if (stored) lastFetchTimeRef.current = Number(stored);
//       } catch (err) {
//         console.warn('⚠️ Failed to load last fetch time', err);
//       }
//     })();
//   }, []);

//   /** ✅ Load expanded state from persistent storage */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_EXPANDED_KEY);
//         if (saved === null) {
//           setIsExpanded(true);
//           await AsyncStorage.setItem(AI_SUGGESTION_EXPANDED_KEY, 'true');
//         } else {
//           setIsExpanded(saved === 'true');
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load expanded state', err);
//         setIsExpanded(true);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 💾 Save expanded state whenever it changes */
//   useEffect(() => {
//     AsyncStorage.setItem(
//       AI_SUGGESTION_EXPANDED_KEY,
//       isExpanded.toString(),
//     ).catch(e => console.warn('⚠️ Failed to save expanded state', e));
//   }, [isExpanded]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
//   useEffect(() => {
//     if (!isAutoMode) return;

//     const runAutoCheck = async () => {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         const parsed = saved ? JSON.parse(saved) : null;

//         // ✅  Only fetch if nothing saved OR cooldown expired
//         if (!parsed?.suggestion || cooldownPassed) {
//           fetchSuggestion('initial');
//           lastFetchTimeRef.current = now;
//         } else {
//           setAiData(parsed);
//           lastSuggestionRef.current = parsed.suggestion;
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to check auto mode cache', err);
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     };

//     runAutoCheck();
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         ref={containerRef}
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <View
//               style={{
//                 width: 40,
//                 height: 40,
//                 borderRadius: 13,
//                 overflow: 'hidden',
//                 borderWidth: 1,
//                 borderColor: theme.colors.surfaceBorder,
//                 marginRight: moderateScale(tokens.spacing.xs),
//               }}>
//               <Image
//                 source={require('../../assets/images/Styla1.png')}
//                 style={{
//                   width: '100%',
//                   height: '100%',
//                   borderRadius: 13,
//                   resizeMode: 'cover',
//                 }}
//               />
//             </View>

//             <Text
//               numberOfLines={1}
//               style={{
//                 flex: 1,
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Styla's Suggestions
//             </Text>

//             {/* Status dot: pulsing green when Auto, grey outline when Manual */}
//             {isAutoMode ? (
//               <Animatable.View
//                 animation={{
//                   0: {scale: 1, opacity: 0.7},
//                   0.5: {scale: 1.3, opacity: 1},
//                   1: {scale: 1, opacity: 0.7},
//                 }}
//                 iterationCount="infinite"
//                 duration={1500}
//                 easing="ease-in-out"
//                 useNativeDriver
//                 style={{
//                   width: 8,
//                   height: 8,
//                   borderRadius: 4,
//                   backgroundColor: '#34C759',
//                   marginLeft: moderateScale(tokens.spacing.xs),
//                 }}
//               />
//             ) : (
//               <View
//                 style={{
//                   width: 8,
//                   height: 8,
//                   borderRadius: 4,
//                   borderWidth: 1.5,
//                   borderColor: theme.colors.muted,
//                   backgroundColor: 'transparent',
//                   marginLeft: moderateScale(tokens.spacing.xs),
//                 }}
//               />
//             )}
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 // fontSize: fontScale(tokens.fontSize.sm),
//                 fontSize: fontScale(tokens.fontSize.base),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{
//                 false: theme.colors.muted,
//                 true: theme.colors.button1,
//               }}
//               ios_backgroundColor={theme.colors.muted}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   key={aiData?.suggestion?.slice(0, 60) || 'empty'}
//                   animation="fadeIn"
//                   duration={250}
//                   useNativeDriver
//                   style={{
//                     opacity: 1, // keep visible
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150,
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       // fontWeight: tokens.fontWeight.semiBold,
//                       // fontSize: fontScale(tokens.fontSize.md),
//                       fontSize: fontScale(tokens.fontSize.base),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.md),
//               }}>
//               Swipe card above for new suggestion
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.sm,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 0, height: 4},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.md),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm)
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs)
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.sm,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: theme.colors.surfaceBorder,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 0, height: 4},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

//////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {findNodeHandle, UIManager} from 'react-native';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const containerRef = useRef<View>(null);

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const [renderTick, setRenderTick] = useState(0);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   const scrollRef = useRef<ScrollView>(null);

//   useEffect(() => {
//     if (!loading && aiData?.suggestion) {
//       // nudge the Animatable tree once the suggestion changes
//       const id = setTimeout(() => setRenderTick(t => t + 1), 20);
//       return () => clearTimeout(id);
//     }
//   }, [loading, aiData?.suggestion]);

//   /** 🧠 Fetch AI suggestion */
//   // const fetchSuggestion = async (trigger: string = 'manual') => {
//   //   if (!weather?.fahrenheit?.main?.temp) {
//   //     console.log('⏸️ Weather not ready, skipping AI fetch.');
//   //     return;
//   //   }

//   //   try {
//   //     setLoading(true);
//   //     setError(null);

//   //     const payload = {user: userName, weather, wardrobe, preferences};
//   //     console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//   //     const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//   //       method: 'POST',
//   //       headers: {'Content-Type': 'application/json'},
//   //       body: JSON.stringify(payload),
//   //     });

//   //     if (!res.ok) throw new Error('Failed to fetch suggestion');
//   //     const data: AiSuggestionResponse = await res.json();
//   //     console.log('✅ AI suggestion data:', data);
//   //     setAiData(data);

//   //     // ✅ force render flush to show new suggestion instantly (frame-perfect)
//   //     requestAnimationFrame(() => {
//   //       setAiData(prev => ({...data}));
//   //     });

//   //     // ✅ ADD — persist the suggestion locally until replaced
//   //     try {
//   //       await AsyncStorage.setItem(
//   //         AI_SUGGESTION_STORAGE_KEY,
//   //         JSON.stringify(data),
//   //       );
//   //     } catch (err) {
//   //       console.warn('⚠️ Failed to save AI suggestion', err);
//   //     }

//   //     const now = Date.now();
//   //     const significantChange =
//   //       lastSuggestionRef.current &&
//   //       data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//   //     if (
//   //       significantChange &&
//   //       now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//   //     ) {
//   //       PushNotification.localNotification({
//   //         title: '✨ New Style Suggestion Ready',
//   //         message: data.suggestion,
//   //         channelId: 'ai-suggestions',
//   //       });
//   //       lastNotifyTimeRef.current = now;
//   //     }

//   //     lastSuggestionRef.current = data.suggestion;
//   //     lastFetchTimeRef.current = now;

//   //     // ✅ persist last fetch time so cooldown survives navigation
//   //     try {
//   //       await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//   //     } catch (err) {
//   //       console.warn('⚠️ Failed to persist last fetch time', err);
//   //     }
//   //   } catch (err) {
//   //     console.error(err);
//   //     setError('Unable to load AI suggestions right now.');
//   //   } finally {
//   //     setLoading(false);
//   //   }
//   // };

//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 [${trigger}] Fetching AI suggestion...`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();

//       console.log(
//         '✅ [fetchSuggestion] Response received:',
//         data?.suggestion?.slice(0, 80),
//       );

//       setAiData(data);
//       console.log('🧩 [setAiData] Initial state set');

//       // ✅ Frame-perfect render flush
//       // ✅ Frame-perfect render flush + layout commit
//       requestAnimationFrame(() => {
//         console.log(
//           '🖼 [requestAnimationFrame] Forcing re-render on next frame',
//         );
//         setAiData({...data});
//         console.log('🧠 [reRender] setAiData fired inside RAF');

//         // ✅ one more micro-tick to trigger text reconciliation
//         setTimeout(() => {
//           setAiData(prev => ({...prev}));
//           console.log('🎯 [LayoutFlush] micro-tick re-render');
//         }, 0);
//       });

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//         console.log('🔔 [Notification] Sent new style suggestion');
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;

//       // Persist fetch time
//       await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//       console.log('⏰ [FetchTime] Saved last fetch timestamp');
//     } catch (err) {
//       console.error('❌ [fetchSuggestion] Error:', err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//       console.log('🏁 [fetchSuggestion] Finished');
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last fetch timestamp */
//   useEffect(() => {
//     (async () => {
//       try {
//         const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
//         if (stored) lastFetchTimeRef.current = Number(stored);
//       } catch (err) {
//         console.warn('⚠️ Failed to load last fetch time', err);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
//   useEffect(() => {
//     if (!isAutoMode) return;

//     const runAutoCheck = async () => {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         const parsed = saved ? JSON.parse(saved) : null;

//         // ✅  Only fetch if nothing saved OR cooldown expired
//         if (!parsed?.suggestion || cooldownPassed) {
//           fetchSuggestion('initial');
//           lastFetchTimeRef.current = now;
//         } else {
//           setAiData(parsed);
//           lastSuggestionRef.current = parsed.suggestion;
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to check auto mode cache', err);
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     };

//     runAutoCheck();
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         ref={containerRef}
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 // textTransform: 'uppercase',
//               }}>
//               AI Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   key={`${
//                     aiData?.suggestion?.slice(0, 60) || 'empty'
//                   }-${renderTick}`}
//                   animation="fadeIn"
//                   duration={250}
//                   useNativeDriver
//                   style={{
//                     opacity: 1, // keep visible
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150,
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion above left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

//////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // ✅ force render flush to show new suggestion instantly
//       setTimeout(() => {
//         setAiData({...data});
//       }, 50);

//       // ✅ ADD — persist the suggestion locally until replaced
//       try {
//         await AsyncStorage.setItem(
//           AI_SUGGESTION_STORAGE_KEY,
//           JSON.stringify(data),
//         );
//       } catch (err) {
//         console.warn('⚠️ Failed to save AI suggestion', err);
//       }

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;

//       // ✅ persist last fetch time so cooldown survives navigation
//       try {
//         await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//       } catch (err) {
//         console.warn('⚠️ Failed to persist last fetch time', err);
//       }
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last fetch timestamp */
//   useEffect(() => {
//     (async () => {
//       try {
//         const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
//         if (stored) lastFetchTimeRef.current = Number(stored);
//       } catch (err) {
//         console.warn('⚠️ Failed to load last fetch time', err);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
//   useEffect(() => {
//     if (!isAutoMode) return;

//     const runAutoCheck = async () => {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         const parsed = saved ? JSON.parse(saved) : null;

//         // ✅  Only fetch if nothing saved OR cooldown expired
//         if (!parsed?.suggestion || cooldownPassed) {
//           fetchSuggestion('initial');
//           lastFetchTimeRef.current = now;
//         } else {
//           setAiData(parsed);
//           lastSuggestionRef.current = parsed.suggestion;
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to check auto mode cache', err);
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     };

//     runAutoCheck();
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 // textTransform: 'uppercase',
//               }}>
//               AI Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion above left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // ✅ ADD — persist the suggestion locally until replaced
//       try {
//         await AsyncStorage.setItem(
//           AI_SUGGESTION_STORAGE_KEY,
//           JSON.stringify(data),
//         );
//       } catch (err) {
//         console.warn('⚠️ Failed to save AI suggestion', err);
//       }

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;

//       // ✅ persist last fetch time so cooldown survives navigation
//       try {
//         await AsyncStorage.setItem('aiStylist_lastFetchTime', String(now));
//       } catch (err) {
//         console.warn('⚠️ Failed to persist last fetch time', err);
//       }
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last fetch timestamp */
//   useEffect(() => {
//     (async () => {
//       try {
//         const stored = await AsyncStorage.getItem('aiStylist_lastFetchTime');
//         if (stored) lastFetchTimeRef.current = Number(stored);
//       } catch (err) {
//         console.warn('⚠️ Failed to load last fetch time', err);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   /** 📡 Auto-fetch on mount if auto mode (respect saved data + cooldown) */
//   useEffect(() => {
//     if (!isAutoMode) return;

//     const runAutoCheck = async () => {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         const parsed = saved ? JSON.parse(saved) : null;

//         // ✅  Only fetch if nothing saved OR cooldown expired
//         if (!parsed?.suggestion || cooldownPassed) {
//           fetchSuggestion('initial');
//           lastFetchTimeRef.current = now;
//         } else {
//           setAiData(parsed);
//           lastSuggestionRef.current = parsed.suggestion;
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to check auto mode cache', err);
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     };

//     runAutoCheck();
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 // textTransform: 'uppercase',
//               }}>
//               AI Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion above left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// // ✅ ADD — persistent suggestion key
// const AI_SUGGESTION_STORAGE_KEY = 'aiStylist_lastSuggestion';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // ✅ ADD — persist the suggestion locally until replaced
//       try {
//         await AsyncStorage.setItem(
//           AI_SUGGESTION_STORAGE_KEY,
//           JSON.stringify(data),
//         );
//       } catch (err) {
//         console.warn('⚠️ Failed to save AI suggestion', err);
//       }

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** ✅ Restore last saved AI suggestion on mount */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(AI_SUGGESTION_STORAGE_KEY);
//         if (saved) {
//           const parsed = JSON.parse(saved);
//           setAiData(parsed);

//           // restore refs for cooldown checks
//           if (parsed?.suggestion) {
//             lastSuggestionRef.current = parsed.suggestion;
//           }
//         }
//       } catch (err) {
//         console.warn('⚠️ Failed to load saved AI suggestion', err);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 // textTransform: 'uppercase',
//               }}>
//               AI Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

/////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';
// import {SafeAreaView} from 'react-native-safe-area-context';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       edges={['left', 'right']} // ✅ disables top & bottom padding
//       style={{flex: 1}}>
//       {/* <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text> */}
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={[globalStyles.section, {marginTop: 6}]}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={[
//             globalStyles.cardStyles5,
//             {
//               backgroundColor: theme.colors.surface,
//               // borderWidth: theme.borderWidth.hairline,
//               // borderColor: theme.colors.surfaceBorder,
//               // padding: moderateScale(tokens.spacing.md1),
//             },
//           ]}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 // textTransform: 'uppercase',
//               }}>
//               AI Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               {isAutoMode ? 'Mode: Automatic' : 'Mode: Manual'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           {/* <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View> */}

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 // borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 // borderWidth: theme.borderWidth.sm,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//                 borderColor: 'rgba(255,255,255,0.6)',
//                 shadowColor: '#000',
//                 shadowOffset: {width: 0, height: 4},
//                 shadowOpacity: 0.4,
//                 shadowRadius: 5,
//                 elevation: 5,
//                 // shadowColor: '#000',
//                 // shadowOffset: {width: 8, height: 9},
//                 // shadowOpacity: 0.4,
//                 // shadowRadius: 5,
//                 // elevation: 6,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   SafeAreaView,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       style={{
//         flex: 1,
//       }}>
//       <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text>
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={{
//           paddingHorizontal: moderateScale(tokens.spacing.md1),
//           paddingBottom: moderateScale(tokens.spacing.lg2), // extra breathing room for small screens
//         }}>
//         {/* 🧠 Floating Mascot — always on top */}
//         {/* <View
//           style={{
//             position: 'absolute',
//             top: 132,
//             right: 100,
//             zIndex: 999999,
//             elevation: 999999,
//           }}>
//           <MascotAssistant
//             position={{bottom: 0, right: 0}}
//             size={67}
//             message="How can I help?"
//           />
//         </View> */}

//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={{
//             backgroundColor: theme.colors.surface,
//             borderRadius: tokens.borderRadius.xxl,
//             borderWidth: theme.borderWidth.hairline,
//             borderColor: theme.colors.surfaceBorder,
//             padding: moderateScale(tokens.spacing.md1),
//           }}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       💡 {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📆 Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       🍂 {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       ⏳ {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📊 {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

/////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   SafeAreaView,
//   ScrollView,
//   Pressable,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';
// import {useResponsive} from '../../hooks/useResponsive';
// import {useWindowDimensions} from 'react-native';
// import {index} from '../../../../backend-nest/dist/pinecone/pineconeUtils';
// import {useAiSuggestionVoiceCommands} from '../../utils/VoiceUtils/VoiceContext';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   const {width, isXS, isSM, isMD} = useResponsive();

//   // inside AiStylistSuggestions component
//   const {width: screenWidth} = useWindowDimensions();
//   const isCompact = screenWidth <= 390; // iPhone SE / 13 mini breakpoint

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       style={{
//         flex: 1,
//       }}>
//       <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         Suggestions
//       </Text>
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={{
//           paddingHorizontal: moderateScale(tokens.spacing.lg),
//           paddingBottom: moderateScale(tokens.spacing.lg2), // extra breathing room for small screens
//         }}>
//         {/* 🧠 Floating Mascot — always on top */}
//         {/* <View
//           style={{
//             position: 'absolute',
//             top: 132,
//             right: 100,
//             zIndex: 999999,
//             elevation: 999999,
//           }}>
//           <MascotAssistant
//             position={{bottom: 0, right: 0}}
//             size={67}
//             message="How can I help?"
//           />
//         </View> */}

//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={{
//             backgroundColor: theme.colors.surface,
//             borderRadius: tokens.borderRadius.xxl,
//             borderWidth: theme.borderWidth.md,
//             borderColor: theme.colors.surfaceBorder,
//             padding: moderateScale(tokens.spacing.md1),
//           }}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.xl,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       💡 {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📆 Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       🍂 {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       ⏳ {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📊 {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <Pressable
//                   onPress={toggleExpanded}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </Pressable>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           {/* <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View> */}

//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           {/* 🔁 Secondary CTAs (with AppleTouchFeedback + haptics + responsive layout) */}
//           <View
//             style={{
//               flexDirection:
//                 isXS || isSM || width < 380 ? 'column' : isMD ? 'row' : 'row', // regular + large phones use row
//               justifyContent: 'center',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               width: '100%',
//             }}>
//             {/* 👚 View Wardrobe Gaps */}
//             <AppleTouchFeedback
//               hapticStyle="impactHeavy"
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginRight:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs) // tighter on regular phones
//                     : moderateScale(tokens.spacing.xsm),
//                 marginBottom:
//                   isXS || isSM ? moderateScale(tokens.spacing.xs) : 0,
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170, // narrower for 390–429 px phones
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </AppleTouchFeedback>

//             {/* 💬 Ask a Styling Question */}
//             <AppleTouchFeedback
//               hapticStyle="impactHeavy"
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: isXS || isSM ? undefined : 1,
//                 width: isXS || isSM ? '100%' : undefined,
//                 marginLeft:
//                   isXS || isSM
//                     ? 0
//                     : isMD
//                     ? moderateScale(tokens.spacing.xxs)
//                     : moderateScale(tokens.spacing.xsm),
//                 paddingVertical: isMD
//                   ? moderateScale(tokens.spacing.xsm) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 paddingHorizontal: isMD
//                   ? moderateScale(tokens.spacing.xs) // slightly shorter buttons
//                   : moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 minWidth: isMD ? 150 : 170,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   SafeAreaView,
//   ScrollView,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';
// import MascotAssistant from '../../components/MascotAssistant/MascotAssistant';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       style={{
//         flex: 1,
//         backgroundColor: theme.colors.background, // maintain theme
//       }}>
//       <Text style={[globalStyles.sectionTitle, {paddingHorizontal: 22}]}>
//         AI Style Suggestions
//       </Text>
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={{
//           paddingHorizontal: moderateScale(tokens.spacing.md2),
//           paddingBottom: moderateScale(tokens.spacing.md), // extra breathing room for small screens
//         }}>
//         <MascotAssistant position={{top: -40, right: 95}} size={67} />

//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={{
//             backgroundColor: theme.colors.surface,
//             // borderRadius: tokens.borderRadius.md,
//             borderRadius: tokens.borderRadius['2xl'],
//             borderWidth: theme.borderWidth.md,
//             borderColor: theme.colors.surfaceBorder,
//             padding: moderateScale(tokens.spacing.md1),
//           }}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.md,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       💡 {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📆 Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       🍂 {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       ⏳ {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📊 {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <TouchableOpacity
//                   onPress={toggleExpanded}
//                   activeOpacity={0.8}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </TouchableOpacity>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           {/* <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View> */}

//           {/* 🔁 Secondary CTAs */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               flexWrap: 'wrap',
//             }}>
//             <TouchableOpacity
//               activeOpacity={0.8}
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: 1, // ✅ evenly share row space
//                 marginRight: moderateScale(tokens.spacing.xsm),
//                 paddingVertical: moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 minWidth: 150,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </TouchableOpacity>

//             <TouchableOpacity
//               activeOpacity={0.8}
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: 1, // ✅ evenly share row space
//                 marginLeft: moderateScale(tokens.spacing.xsm),
//                 paddingVertical: moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 minWidth: 150,
//                 marginTop: moderateScale(tokens.spacing.xsm), // ✅ only applies if wrapping occurs
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </TouchableOpacity>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

//////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   SafeAreaView,
//   ScrollView,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';
// import {fontScale, moderateScale} from '../../utils/scale';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <SafeAreaView
//       style={{
//         flex: 1,
//         backgroundColor: theme.colors.background, // maintain theme
//       }}>
//       <ScrollView
//         showsVerticalScrollIndicator={false}
//         contentContainerStyle={{
//           paddingHorizontal: moderateScale(tokens.spacing.md2),
//           paddingBottom: moderateScale(tokens.spacing.md), // extra breathing room for small screens
//         }}>
//         <Animatable.View
//           animation="fadeInUp"
//           delay={200}
//           duration={700}
//           useNativeDriver
//           style={{
//             backgroundColor: theme.colors.surface,
//             borderRadius: tokens.borderRadius.md,
//             borderWidth: theme.borderWidth.md,
//             borderColor: theme.colors.surfaceBorder,
//             padding: moderateScale(tokens.spacing.md1),
//           }}>
//           {/* 🧠 Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.xsm),
//             }}>
//             <Icon
//               name="stars"
//               size={22}
//               color={theme.colors.button1}
//               style={{marginRight: moderateScale(tokens.spacing.xs)}}
//             />
//             <Text
//               style={{
//                 fontSize: fontScale(tokens.fontSize.lg),
//                 fontWeight: tokens.fontWeight.bold,
//                 color: theme.colors.foreground,
//                 textTransform: 'uppercase',
//               }}>
//               Suggestions
//             </Text>
//           </View>

//           {/* 🧠 Manual / Auto Switch */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginBottom: moderateScale(tokens.spacing.sm2),
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground2,
//                 fontSize: fontScale(tokens.fontSize.sm),
//                 marginTop: moderateScale(tokens.spacing.nano),
//               }}>
//               Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//             </Text>
//             <Switch
//               value={isAutoMode}
//               onValueChange={setIsAutoMode}
//               trackColor={{false: '#555', true: theme.colors.button1}}
//               thumbColor={isAutoMode ? '#fff' : '#ccc'}
//             />
//           </View>

//           {/* 💬 Suggestion Card (swipe zone) */}
//           <SwipeableCard
//             onSwipeLeft={() => fetchSuggestion('manual')}
//             onSwipeRight={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }
//             deleteThreshold={0.08}
//             style={{
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.md,
//               borderWidth: theme.borderWidth.hairline,
//               borderColor: theme.colors.muted,
//               padding: moderateScale(tokens.spacing.sm),
//             }}>
//             {loading && (
//               <ActivityIndicator
//                 color={theme.colors.button1}
//                 style={{marginVertical: moderateScale(tokens.spacing.md2)}}
//               />
//             )}

//             {!loading && (
//               <>
//                 <Animatable.View
//                   transition="maxHeight"
//                   duration={400}
//                   style={{
//                     overflow: 'hidden',
//                     maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//                   }}>
//                   <Text
//                     style={{
//                       fontSize: fontScale(tokens.fontSize.md),
//                       fontWeight: tokens.fontWeight.semiBold,
//                       color: theme.colors.foreground,
//                       lineHeight: 22,
//                       marginBottom: moderateScale(tokens.spacing.md),
//                       paddingHorizontal: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {error
//                       ? fallbackSuggestion()
//                       : aiData?.suggestion || fallbackSuggestion()}
//                   </Text>

//                   {aiData?.insight && (
//                     <Animatable.Text
//                       animation="fadeIn"
//                       delay={300}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         fontStyle: 'italic',
//                         marginBottom: moderateScale(tokens.spacing.sm2),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       💡 {aiData.insight}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.tomorrow && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={400}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📆 Tomorrow: {aiData.tomorrow}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.seasonalForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={500}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       🍂 {aiData.seasonalForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.lifecycleForecast && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={600}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       ⏳ {aiData.lifecycleForecast}
//                     </Animatable.Text>
//                   )}

//                   {aiData?.styleTrajectory && (
//                     <Animatable.Text
//                       animation="fadeInUp"
//                       delay={700}
//                       style={{
//                         fontSize: fontScale(tokens.fontSize.md),
//                         color: theme.colors.foreground2,
//                         marginBottom: moderateScale(tokens.spacing.md1),
//                         lineHeight: 20,
//                         marginHorizontal: moderateScale(tokens.spacing.md),
//                       }}>
//                       📊 {aiData.styleTrajectory}
//                     </Animatable.Text>
//                   )}
//                 </Animatable.View>

//                 {/* 👇 Collapse / Expand toggle */}
//                 <TouchableOpacity
//                   onPress={toggleExpanded}
//                   activeOpacity={0.8}
//                   style={{
//                     alignItems: 'center',
//                     paddingVertical: moderateScale(tokens.spacing.xsm),
//                     flexDirection: 'row',
//                     justifyContent: 'center',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.button1,
//                       fontWeight: tokens.fontWeight.semiBold,
//                       fontSize: fontScale(tokens.fontSize.md),
//                       marginRight: moderateScale(tokens.spacing.xxs),
//                     }}>
//                     {isExpanded ? 'Show Less' : 'Show More'}
//                   </Text>
//                   <Animatable.View
//                     duration={250}
//                     style={{
//                       transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                     }}>
//                     <Icon
//                       name="expand-more"
//                       size={24}
//                       color={theme.colors.button1}
//                     />
//                   </Animatable.View>
//                 </TouchableOpacity>
//               </>
//             )}
//           </SwipeableCard>

//           {/* 🧭 Subtle swipe hint */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               marginTop: moderateScale(tokens.spacing.md2),
//               opacity: 0.6,
//               marginRight: moderateScale(tokens.spacing.md2),
//             }}>
//             <Icon
//               name="chevron-left"
//               size={35}
//               color={theme.colors.foreground}
//               style={{marginTop: -7.5}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: fontScale(tokens.fontSize.base),
//               }}>
//               Swipe suggestion left for new result
//             </Text>
//           </View>

//           {/* 🔁 Secondary CTAs */}
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'space-between',
//               alignItems: 'center',
//               marginTop: moderateScale(tokens.spacing.md1),
//               flexWrap: 'wrap',
//             }}>
//             <TouchableOpacity
//               activeOpacity={0.8}
//               onPress={() => navigate('Wardrobe')}
//               style={{
//                 flex: 1, // ✅ evenly share row space
//                 marginRight: moderateScale(tokens.spacing.xsm),
//                 paddingVertical: moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 minWidth: 150,
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 View Wardrobe Gaps
//               </Text>
//             </TouchableOpacity>

//             <TouchableOpacity
//               activeOpacity={0.8}
//               onPress={() => navigate('AiStylistChatScreen')}
//               style={{
//                 flex: 1, // ✅ evenly share row space
//                 marginLeft: moderateScale(tokens.spacing.xsm),
//                 paddingVertical: moderateScale(tokens.spacing.xsm),
//                 borderRadius: tokens.borderRadius.md,
//                 backgroundColor: theme.colors.button1,
//                 borderWidth: theme.borderWidth.sm,
//                 borderColor: theme.colors.surfaceBorder,
//                 alignItems: 'center',
//                 minWidth: 150,
//                 marginTop: moderateScale(tokens.spacing.xsm), // ✅ only applies if wrapping occurs
//               }}>
//               <Text
//                 style={{
//                   fontSize: fontScale(tokens.fontSize.sm),
//                   fontWeight: tokens.fontWeight.semiBold,
//                   color: theme.colors.buttonText1,
//                 }}>
//                 Ask a Styling Question
//               </Text>
//             </TouchableOpacity>
//           </View>
//         </Animatable.View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// };

// export default AiStylistSuggestions;

//////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   const [isExpanded, setIsExpanded] = useState(true);
//   const toggleExpanded = () => setIsExpanded(prev => !prev);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         borderWidth: theme.borderWidth.md,
//         borderColor: theme.colors.surfaceBorder,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//           }}>
//           AI Style Suggestions
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{color: theme.colors.foreground2, fontSize: 14, marginTop: 4}}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         deleteThreshold={0.08}
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           borderWidth: theme.borderWidth.md,
//           borderColor: theme.colors.surfaceBorder,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Animatable.View
//               transition="maxHeight"
//               duration={400}
//               style={{
//                 overflow: 'hidden',
//                 maxHeight: isExpanded ? 1000 : 150, // 👈 show only ~2 lines collapsed
//               }}>
//               <Text
//                 style={{
//                   fontSize: 15,
//                   fontWeight: '600',
//                   color: theme.colors.foreground,
//                   lineHeight: 22,
//                   marginBottom: 16,
//                   paddingHorizontal: 6,
//                 }}>
//                 {error
//                   ? fallbackSuggestion()
//                   : aiData?.suggestion || fallbackSuggestion()}
//               </Text>

//               {aiData?.insight && (
//                 <Animatable.Text
//                   animation="fadeIn"
//                   delay={300}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     fontStyle: 'italic',
//                     marginBottom: 14,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   💡 {aiData.insight}
//                 </Animatable.Text>
//               )}

//               {aiData?.tomorrow && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={400}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   📆 Tomorrow: {aiData.tomorrow}
//                 </Animatable.Text>
//               )}

//               {aiData?.seasonalForecast && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={500}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   🍂 {aiData.seasonalForecast}
//                 </Animatable.Text>
//               )}

//               {aiData?.lifecycleForecast && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={600}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   ⏳ {aiData.lifecycleForecast}
//                 </Animatable.Text>
//               )}

//               {aiData?.styleTrajectory && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={700}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   📊 {aiData.styleTrajectory}
//                 </Animatable.Text>
//               )}
//             </Animatable.View>

//             {/* 👇 Collapse / Expand toggle */}
//             <TouchableOpacity
//               onPress={toggleExpanded}
//               activeOpacity={0.8}
//               style={{
//                 alignItems: 'center',
//                 paddingVertical: 10,
//                 flexDirection: 'row',
//                 justifyContent: 'center',
//               }}>
//               <Text
//                 style={{
//                   color: theme.colors.button1,
//                   fontWeight: '600',
//                   fontSize: 15,
//                   marginRight: 6,
//                 }}>
//                 {isExpanded ? 'Show Less' : 'Show More'}
//               </Text>
//               <Animatable.View
//                 duration={250}
//                 style={{
//                   transform: [{rotate: isExpanded ? '180deg' : '0deg'}],
//                 }}>
//                 <Icon
//                   name="expand-more"
//                   size={24}
//                   color={theme.colors.button1}
//                 />
//               </Animatable.View>
//             </TouchableOpacity>
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       {/* <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text style={globalStyles.buttonPrimaryText}>Refresh Suggestion</Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View> */}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 14,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 17,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 17,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Subtle swipe hint */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           marginTop: 20,
//           opacity: 0.6,
//           marginRight: 20,
//         }}>
//         <Icon
//           name="chevron-left"
//           size={35}
//           color={theme.colors.foreground}
//           style={{marginTop: -7.5}}
//         />
//         <Text
//           style={{
//             color: theme.colors.foreground,
//             fontSize: 16,
//           }}>
//           Swipe suggestion left for new result
//         </Text>
//         {/* <Text style={{color: theme.colors.foreground, fontSize: 13}}>
//           Swipe right to create outfit
//         </Text> */}
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

//////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//           }}>
//           AI Style Suggestions
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{color: theme.colors.foreground2, fontSize: 14, marginTop: 4}}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         deleteThreshold={0.08} // 🔥 <-- ADD THIS LINE (lower threshold = lighter swipe)
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 15,
//                 fontWeight: '600',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       {/* <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text style={globalStyles.buttonPrimaryText}>Refresh Suggestion</Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View> */}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 14,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Subtle swipe hint */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           marginTop: 20,
//           opacity: 0.6,
//           marginRight: 20,
//         }}>
//         <Icon
//           name="chevron-left"
//           size={35}
//           color={theme.colors.foreground}
//           style={{marginTop: -7.5}}
//         />
//         <Text
//           style={{
//             color: theme.colors.foreground,
//             fontSize: 16,
//           }}>
//           Swipe suggestion left for new result
//         </Text>
//         {/* <Text style={{color: theme.colors.foreground, fontSize: 13}}>
//           Swipe right to create outfit
//         </Text> */}
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//           }}>
//           AI Style Suggestions
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{color: theme.colors.foreground2, fontSize: 14, marginTop: 4}}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         deleteThreshold={0.08} // 🔥 <-- ADD THIS LINE (lower threshold = lighter swipe)
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 15,
//                 fontWeight: '600',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       {/* <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text style={globalStyles.buttonPrimaryText}>Refresh Suggestion</Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View> */}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 14,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               // textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Subtle swipe hint */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Icon
//           name="chevron-left"
//           size={35}
//           color={theme.colors.foreground}
//           style={{marginTop: -7.5}}
//         />
//         <Text
//           style={{
//             color: theme.colors.foreground,
//             fontSize: 16,
//           }}>
//           Swipe suggestion left for new result
//         </Text>
//         {/* <Text style={{color: theme.colors.foreground, fontSize: 13}}>
//           Swipe right to create outfit
//         </Text> */}
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//           }}>
//           AI Style Suggestions
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text style={{color: theme.colors.foreground2, fontSize: 14}}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 14,
//                 fontWeight: '500',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       {/* <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text style={globalStyles.buttonPrimaryText}>Refresh Suggestion</Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View> */}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Subtle swipe hint */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Icon
//           name="chevron-left"
//           size={35}
//           color={theme.colors.foreground}
//           style={{marginTop: -7.5}}
//         />
//         <Text
//           style={{
//             color: theme.colors.foreground,
//             fontSize: 16,
//           }}>
//           Swipe suggestion left for new result
//         </Text>
//         {/* <Text style={{color: theme.colors.foreground, fontSize: 13}}>
//           Swipe right to create outfit
//         </Text> */}
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   weather: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🕐 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) throw new Error('Failed to fetch suggestion');
//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📊 Load saved auto-mode preference */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Save auto-mode preference */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch on mount if auto mode */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;
//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Auto-refresh every 4h */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () =>
//       refreshTimerRef.current && clearInterval(refreshTimerRef.current);
//   }, [isAutoMode]);

//   /** 🔄 Refresh when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         if (now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS) {
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//           }}>
//           AI Style Suggestions
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text style={{color: theme.colors.foreground2, fontSize: 14}}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 14,
//                 fontWeight: '500',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       {/* <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text style={globalStyles.buttonPrimaryText}>Refresh Suggestion</Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View> */}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Subtle swipe hint */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Icon
//           name="chevron-left"
//           size={35}
//           color={theme.colors.foreground}
//           style={{marginTop: -7.5}}
//         />
//         <Text
//           style={{
//             color: theme.colors.foreground,
//             fontSize: 16,
//           }}>
//           Swipe suggestion left for new result
//         </Text>
//         {/* <Text style={{color: theme.colors.foreground, fontSize: 13}}>
//           Swipe right to create outfit
//         </Text> */}
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

///////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   Animated,
//   PanResponder,
//   Dimensions,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}

//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 14,
//                 fontWeight: '500',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 paddingVertical: 13,
//                 marginBottom: 12,
//                 marginTop: 6,
//                 width: 230,
//               },
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Swipe hints */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👈 Swipe left for new suggestion
//         </Text>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👉 Swipe right to save
//         </Text>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   Animated,
//   PanResponder,
//   Dimensions,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import SwipeableCard from '../../components/SwipeableCard/SwipeableCard';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}

//       <SwipeableCard
//         onSwipeLeft={() => fetchSuggestion('manual')}
//         onSwipeRight={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }
//         style={{
//           backgroundColor: theme.colors.surface2,
//           borderRadius: tokens.borderRadius.md,
//           padding: 12,
//         }}>
//         {loading && (
//           <ActivityIndicator
//             color={theme.colors.button1}
//             style={{marginVertical: 20}}
//           />
//         )}

//         {!loading && (
//           <>
//             <Text
//               style={{
//                 fontSize: 14,
//                 fontWeight: '500',
//                 color: theme.colors.foreground,
//                 lineHeight: 22,
//                 marginBottom: 16,
//                 paddingHorizontal: 6,
//               }}>
//               {error
//                 ? fallbackSuggestion()
//                 : aiData?.suggestion || fallbackSuggestion()}
//             </Text>

//             {aiData?.insight && (
//               <Animatable.Text
//                 animation="fadeIn"
//                 delay={300}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   fontStyle: 'italic',
//                   marginBottom: 14,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 💡 {aiData.insight}
//               </Animatable.Text>
//             )}

//             {aiData?.tomorrow && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={400}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📆 Tomorrow: {aiData.tomorrow}
//               </Animatable.Text>
//             )}

//             {aiData?.seasonalForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={500}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 🍂 {aiData.seasonalForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.lifecycleForecast && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={600}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 ⏳ {aiData.lifecycleForecast}
//               </Animatable.Text>
//             )}

//             {aiData?.styleTrajectory && (
//               <Animatable.Text
//                 animation="fadeInUp"
//                 delay={700}
//                 style={{
//                   fontSize: 15,
//                   color: theme.colors.foreground2,
//                   marginBottom: 18,
//                   lineHeight: 20,
//                   marginHorizontal: 16,
//                 }}>
//                 📊 {aiData.styleTrajectory}
//               </Animatable.Text>
//             )}
//           </>
//         )}
//       </SwipeableCard>

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 paddingVertical: 13,
//                 marginBottom: 12,
//                 marginTop: 6,
//                 width: 230,
//               },
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Swipe hints */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👈 Swipe left for new suggestion
//         </Text>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👉 Swipe right to save
//         </Text>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
//   Animated,
//   PanResponder,
//   Dimensions,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const SCREEN_WIDTH = Dimensions.get('window').width;

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false);

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   // 🪄 Gesture + haptics setup (drop-in replacement)
//   const panX = useRef(new Animated.Value(0)).current;
//   const SWIPE_DISMISS = Math.min(140, SCREEN_WIDTH * 0.28);

//   const panResponder = useRef(
//     PanResponder.create({
//       // only start if it's a real horizontal swipe (prevents vertical scroll conflict)
//       onMoveShouldSetPanResponder: (_evt, g) =>
//         Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
//       onMoveShouldSetPanResponderCapture: (_evt, g) =>
//         Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),

//       // once we've claimed it, don't let scroll steal it mid-gesture
//       onPanResponderTerminationRequest: () => false,

//       onPanResponderMove: (_evt, g) => {
//         // small clamp feels nicer
//         const nextX = Math.max(-SCREEN_WIDTH, Math.min(SCREEN_WIDTH, g.dx));
//         panX.setValue(nextX);
//       },

//       onPanResponderRelease: (_evt, g) => {
//         if (g.dx > SWIPE_DISMISS) {
//           // 👉 approve → generate look
//           triggerHaptic('impactLight');
//           Animated.timing(panX, {
//             toValue: SCREEN_WIDTH + 40,
//             duration: 200,
//             useNativeDriver: true,
//           }).start(() => {
//             panX.setValue(0);
//             if (aiData?.suggestion) {
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData.suggestion,
//                 autogenerate: true,
//               });
//             }
//           });
//         } else if (g.dx < -SWIPE_DISMISS) {
//           // 👈 reject → fetch new suggestion
//           triggerHaptic('impactLight');
//           Animated.timing(panX, {
//             toValue: -SCREEN_WIDTH - 40,
//             duration: 200,
//             useNativeDriver: true,
//           }).start(() => {
//             panX.setValue(0);
//             fetchSuggestion('manual'); // same function as you asked
//           });
//         } else {
//           // not far enough → snap back smoothly
//           Animated.spring(panX, {
//             toValue: 0,
//             useNativeDriver: true,
//             bounciness: 8,
//           }).start();
//         }
//       },

//       onPanResponderTerminate: () => {
//         // if something interrupts, snap back
//         Animated.spring(panX, {toValue: 0, useNativeDriver: true}).start();
//       },
//     }),
//   ).current;

//   // nice subtle fade while swiping
//   const cardAnimatedStyle = {
//     transform: [{translateX: panX}],
//     opacity: panX.interpolate({
//       inputRange: [-SCREEN_WIDTH, 0, SCREEN_WIDTH],
//       outputRange: [0.5, 1, 0.5],
//     }),
//   };
//   const triggerHaptic = (type = 'impactMedium') => {
//     ReactNativeHapticFeedback.trigger(type, {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });
//   };

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion Card (swipe zone) */}
//       <View pointerEvents="box-none">
//         <Animated.View
//           {...panResponder.panHandlers}
//           style={[
//             {
//               backgroundColor: theme.colors.surface2,
//               borderRadius: tokens.borderRadius.md,
//               padding: 12,
//             },
//             cardAnimatedStyle, // ✅ key: translateX + fade
//           ]}>
//           {loading && (
//             <ActivityIndicator
//               color={theme.colors.button1}
//               style={{marginVertical: 20}}
//             />
//           )}

//           {!loading && (
//             <>
//               <Text
//                 style={{
//                   fontSize: 14,
//                   fontWeight: '500',
//                   color: theme.colors.foreground,
//                   lineHeight: 22,
//                   marginBottom: 16,
//                   paddingHorizontal: 6,
//                 }}>
//                 {error
//                   ? fallbackSuggestion()
//                   : aiData?.suggestion || fallbackSuggestion()}
//               </Text>

//               {aiData?.insight && (
//                 <Animatable.Text
//                   animation="fadeIn"
//                   delay={300}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     fontStyle: 'italic',
//                     marginBottom: 14,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   💡 {aiData.insight}
//                 </Animatable.Text>
//               )}

//               {aiData?.tomorrow && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={400}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   📆 Tomorrow: {aiData.tomorrow}
//                 </Animatable.Text>
//               )}

//               {aiData?.seasonalForecast && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={500}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   🍂 {aiData.seasonalForecast}
//                 </Animatable.Text>
//               )}

//               {aiData?.lifecycleForecast && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={600}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   ⏳ {aiData.lifecycleForecast}
//                 </Animatable.Text>
//               )}

//               {aiData?.styleTrajectory && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={700}
//                   style={{
//                     fontSize: 15,
//                     color: theme.colors.foreground2,
//                     marginBottom: 18,
//                     lineHeight: 20,
//                     marginHorizontal: 16,
//                   }}>
//                   📊 {aiData.styleTrajectory}
//                 </Animatable.Text>
//               )}
//             </>
//           )}
//         </Animated.View>
//       </View>

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center', marginTop: 20}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 paddingVertical: 13,
//                 marginBottom: 12,
//                 marginTop: 6,
//                 width: 230,
//               },
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>

//       {/* 🧭 Swipe hints */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 20,
//           opacity: 0.6,
//         }}>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👈 Swipe left for new suggestion
//         </Text>
//         <Text style={{color: theme.colors.foreground2, fontSize: 13}}>
//           👉 Swipe right to save
//         </Text>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

//////////////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 16,
//               paddingHorizontal: 6,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}

//           {/* 🪄 Predictive Fields (only render if present) */}
//           {aiData?.seasonalForecast && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={500}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               🍂 {aiData.seasonalForecast}
//             </Animatable.Text>
//           )}

//           {aiData?.lifecycleForecast && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={600}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               ⏳ {aiData.lifecycleForecast}
//             </Animatable.Text>
//           )}

//           {aiData?.styleTrajectory && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={700}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📊 {aiData.styleTrajectory}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
//   seasonalForecast?: string;
//   lifecycleForecast?: string;
//   styleTrajectory?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   weather,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 16,
//               paddingHorizontal: 6,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}

//           {/* 🪄 Predictive Fields (only render if present) */}
//           {aiData?.seasonalForecast && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={500}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               🍂 {aiData.seasonalForecast}
//             </Animatable.Text>
//           )}

//           {aiData?.lifecycleForecast && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={600}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               ⏳ {aiData.lifecycleForecast}
//             </Animatable.Text>
//           )}

//           {aiData?.styleTrajectory && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={700}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📊 {aiData.styleTrajectory}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   // theme,
//   weather,
//   // globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme, setSkin} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           // ✅ First-time user or reinstalled app: force manual mode
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         // ✅ Fallback default
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 16,
//               paddingHorizontal: 6,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   // theme,
//   weather,
//   // globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme, setSkin} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle */
//   // useEffect(() => {
//   //   (async () => {
//   //     try {
//   //       const saved = await AsyncStorage.getItem(STORAGE_KEY);
//   //       if (saved !== null) setIsAutoMode(saved === 'true');
//   //     } catch (e) {
//   //       console.warn('⚠️ Failed to load auto mode setting', e);
//   //     }
//   //   })();
//   // }, []);

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           // ✅ First-time user or reinstalled app: force manual mode
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         // ✅ Fallback default
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 20,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         borderWidth: theme.borderWidth.xl,
//         borderColor: theme.colors.surface3,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 0}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 0,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 14,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '400',
//             marginTop: 8,
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 16,
//               paddingHorizontal: 6,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//                 marginHorizontal: 16,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 14, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: tokens.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, marginTop: 6, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   // theme,
//   weather,
//   // globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme, setSkin} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle */
//   // useEffect(() => {
//   //   (async () => {
//   //     try {
//   //       const saved = await AsyncStorage.getItem(STORAGE_KEY);
//   //       if (saved !== null) setIsAutoMode(saved === 'true');
//   //     } catch (e) {
//   //       console.warn('⚠️ Failed to load auto mode setting', e);
//   //     }
//   //   })();
//   // }, []);

//   /** 🗂️ Load persisted toggle — default to manual if not set */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);

//         if (saved === null) {
//           // ✅ First-time user or reinstalled app: force manual mode
//           setIsAutoMode(false);
//           await AsyncStorage.setItem(STORAGE_KEY, 'false');
//         } else {
//           setIsAutoMode(saved === 'true');
//         }
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//         // ✅ Fallback default
//         setIsAutoMode(false);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 16,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '500',
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
//   Switch,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown
// const STORAGE_KEY = 'aiStylistAutoMode';

// const AiStylistSuggestions: React.FC<Props> = ({
//   // theme,
//   weather,
//   // globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const {theme, setSkin} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [isAutoMode, setIsAutoMode] = useState(false); // 🔥 persisted mode

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notify only if significant change
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 🗂️ Load persisted toggle */
//   useEffect(() => {
//     (async () => {
//       try {
//         const saved = await AsyncStorage.getItem(STORAGE_KEY);
//         if (saved !== null) setIsAutoMode(saved === 'true');
//       } catch (e) {
//         console.warn('⚠️ Failed to load auto mode setting', e);
//       }
//     })();
//   }, []);

//   /** 💾 Persist toggle change */
//   useEffect(() => {
//     AsyncStorage.setItem(STORAGE_KEY, isAutoMode.toString()).catch(e =>
//       console.warn('⚠️ Failed to save auto mode setting', e),
//     );
//   }, [isAutoMode]);

//   /** 📡 Auto-fetch once on mount (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       const now = Date.now();
//       const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//       if (!aiData || cooldownPassed) {
//         fetchSuggestion('initial');
//         lastFetchTimeRef.current = now;
//       } else {
//         console.log('⏸️ Skipping AI fetch — cooldown not reached');
//       }
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [isAutoMode]);

//   /** 🔁 Refresh every 4 hours (if auto mode) */
//   useEffect(() => {
//     if (isAutoMode) {
//       refreshTimerRef.current = setInterval(() => {
//         fetchSuggestion('scheduled');
//       }, NOTIFICATION_COOLDOWN_MS);
//     }
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, [isAutoMode]);

//   /** 📱 Refresh on resume (if auto mode) */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (isAutoMode && state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, [isAutoMode]);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: tokens.borderRadius.md,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 🧠 Manual / Auto Switch */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           alignItems: 'center',
//           marginBottom: 16,
//         }}>
//         <Text
//           style={{
//             color: theme.colors.foreground2,
//             fontSize: 14,
//             fontWeight: '500',
//           }}>
//           Mode: {isAutoMode ? 'Automatic Mode' : 'Manual Mode'}
//         </Text>
//         <Switch
//           value={isAutoMode}
//           onValueChange={setIsAutoMode}
//           trackColor={{false: '#555', true: theme.colors.button1}}
//           thumbColor={isAutoMode ? '#fff' : '#ccc'}
//         />
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

////////////////////////

// // src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// // 🔁 Cooldown windows
// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h notification interval
// const FETCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h re-fetch cooldown

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   // 📊 Memory refs
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const lastFetchTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {user: userName, weather, wardrobe, preferences};
//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Notification logic (only if suggestion meaningfully changed)
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60);

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//       lastFetchTimeRef.current = now;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion if API fails */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📡 Auto-fetch once on mount (smart cooldown) */
//   useEffect(() => {
//     const now = Date.now();
//     const cooldownPassed = now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//     if (!aiData || cooldownPassed) {
//       fetchSuggestion('initial');
//       lastFetchTimeRef.current = now;
//     } else {
//       console.log(
//         '⏸️ Skipping AI fetch — data exists and cooldown not reached',
//       );
//     }
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);

//   /** 🔁 Refresh every 4 hours */
//   useEffect(() => {
//     refreshTimerRef.current = setInterval(() => {
//       fetchSuggestion('scheduled');
//     }, NOTIFICATION_COOLDOWN_MS);

//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, []);

//   /** 📱 Refresh when app comes to foreground */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (state === 'active') {
//         const now = Date.now();
//         const cooldownPassed =
//           now - lastFetchTimeRef.current > FETCH_COOLDOWN_MS;

//         if (cooldownPassed) {
//           console.log('📱 App resumed — refreshing AI suggestion');
//           fetchSuggestion('resume');
//           lastFetchTimeRef.current = now;
//         } else {
//           console.log('📱 App resumed — cooldown not passed, skipping fetch');
//         }
//       }
//     });
//     return () => subscription.remove();
//   }, []);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔁 Buttons */}
//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// // AUTOMATED VERSION AI AGENT BELOW FULL BLOW BUT RENDERS TOO MUCH

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const lastSuggestionRef = useRef<string | null>(null);
//   const lastNotifyTimeRef = useRef<number>(0);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);
//       setAiData(data);

//       // 🧠 Only notify if new suggestion is significantly different AND cooldown passed
//       const now = Date.now();
//       const significantChange =
//         lastSuggestionRef.current &&
//         data.suggestion.slice(0, 60) !== lastSuggestionRef.current.slice(0, 60); // ignore minor rewording

//       if (
//         significantChange &&
//         now - lastNotifyTimeRef.current > NOTIFICATION_COOLDOWN_MS
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//         lastNotifyTimeRef.current = now;
//       }

//       lastSuggestionRef.current = data.suggestion;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Fallback suggestion */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📡 Auto-fetch only ONCE on mount */
//   useEffect(() => {
//     fetchSuggestion('initial');
//     // ⛔ intentionally no dependencies to prevent infinite loops
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);

//   /** 🔁 Refresh every 4 hours */
//   useEffect(() => {
//     refreshTimerRef.current = setInterval(() => {
//       fetchSuggestion('scheduled');
//     }, NOTIFICATION_COOLDOWN_MS);
//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, []);

//   /** 📱 Refresh when app returns to foreground */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (state === 'active') {
//         console.log('📱 App resumed — refreshing AI suggestion');
//         fetchSuggestion('resume');
//       }
//     });
//     return () => subscription.remove();
//   }, []);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       <View style={{alignItems: 'center'}}>
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// AUTOMATED VERSION AI AGENT BELOW

// src/components/AiStylistSuggestions/AiStylistSuggestions.tsx
// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   ActivityIndicator,
//   AppState,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';
// import PushNotification from 'react-native-push-notification';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const lastSuggestionRef = useRef<string | null>(null);
//   const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

//   /** 🧠 Fetch AI suggestion from backend */
//   const fetchSuggestion = async (trigger: string = 'manual') => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log(`🤖 Fetching AI suggestion (trigger: ${trigger})`);
//       console.log('📦 Payload:', JSON.stringify(payload));

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data: AiSuggestionResponse = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData(data);

//       // 🔔 Notify user only if new suggestion is significantly different
//       if (
//         lastSuggestionRef.current &&
//         data.suggestion !== lastSuggestionRef.current
//       ) {
//         PushNotification.localNotification({
//           title: '✨ New Style Suggestion Ready',
//           message: data.suggestion,
//           channelId: 'ai-suggestions',
//         });
//       }

//       lastSuggestionRef.current = data.suggestion;
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 🧠 Fallback suggestion when AI unavailable */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers.';
//     else if (temp < 65)
//       base =
//         'Mild — lightweight layers and versatile pieces will keep you ready.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool.';
//     else if (temp < 90) base = 'Hot — keep it ultra-light, airy, and minimal.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Waterproof layers will keep you dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   /** 📡 Auto-fetch on mount, context change, and schedule */
//   useEffect(() => {
//     // Initial auto-fetch
//     fetchSuggestion('initial');

//     // Re-run whenever weather or wardrobe changes significantly
//     // This is a key behavior difference from a simple chatbot
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [weather?.fahrenheit?.main?.temp, wardrobe?.length]);

//   /** 🔄 Refresh every 4 hours */
//   useEffect(() => {
//     refreshTimerRef.current = setInterval(() => {
//       fetchSuggestion('scheduled');
//     }, 4 * 60 * 60 * 1000); // 4 hours

//     return () => {
//       if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
//     };
//   }, []);

//   /** 💤 Background wake-up when app resumes */
//   useEffect(() => {
//     const subscription = AppState.addEventListener('change', state => {
//       if (state === 'active') {
//         console.log('📱 App resumed — refreshing AI suggestion');
//         fetchSuggestion('resume');
//       }
//     });
//     return () => subscription.remove();
//   }, []);

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Agent
//         </Text>
//       </View>

//       {/* 💬 Suggestion or fallback */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       <View style={{alignItems: 'center'}}>
//         {/* 🔘 Manual refresh button */}
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={() => fetchSuggestion('manual')}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Refresh Suggestion
//           </Text>
//         </AppleTouchFeedback>

//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 0,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////////

// AI AGENT TRIGGERED MANUALLY WORKING - BELOW HERE - KEEP

// import React, {useState} from 'react';
// import {View, Text, TouchableOpacity, ActivityIndicator} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   /** 🧠 Manual fetch — only runs when button pressed */
//   const fetchSuggestion = async () => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log('📦 Payload:', JSON.stringify(payload));
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData({
//         suggestion: data.suggestion || 'Unable to generate a suggestion.',
//         insight: data.insight || undefined,
//         tomorrow: data.tomorrow || undefined,
//       });
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Local fallback aligned with Weather section */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp)
//       return 'Tap "Generate Suggestions" to get style guidance tailored to today’s weather.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — focus on insulating layers, weather-resistant outerwear, and warm accessories.';
//     else if (temp < 50)
//       base =
//         'Chilly — add mid-weight layers like knitwear or light outer layers for balanced warmth.';
//     else if (temp < 65)
//       base =
//         'Mild and comfortable — lightweight layers and versatile pieces will keep you ready for changing conditions.';
//     else if (temp < 80)
//       base =
//         'Warm — breathable fabrics and relaxed outfits will help you stay cool and comfortable.';
//     else if (temp < 90)
//       base =
//         'Hot — keep it ultra-light, airy, and minimal with moisture-wicking clothing.';
//     else
//       base =
//         'Scorching — prioritize ventilation, loose fits, and sun-protective materials.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Consider waterproof layers or accessories to stay dry.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Choose insulated footwear and moisture-resistant outerwear.';
//     if (condition === 'Clear')
//       extra = ' 😎 Sunglasses can add both comfort and style.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutral tones and flexible layering pieces will work well.';

//     return `${base}${extra}`;
//   };

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Suggests
//         </Text>
//       </View>

//       {/* 💬 Suggestion or fallback */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 14,
//               fontWeight: '500',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       <View style={{alignItems: 'center'}}>
//         {/* 🔘 Button: Trigger AI manually */}
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={fetchSuggestion}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Generate Suggestions
//           </Text>
//         </AppleTouchFeedback>

//         {/* ✨ Only show "Generate Full Look" once AI data is available */}
//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>Generate Look</Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 0,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

//////////////////

// import React, {useState} from 'react';
// import {View, Text, TouchableOpacity, ActivityIndicator} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   /** 🧠 Manual fetch — only runs when button pressed */
//   const fetchSuggestion = async () => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log('📦 Payload:', JSON.stringify(payload));
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData({
//         suggestion: data.suggestion || 'Unable to generate a suggestion.',
//         insight: data.insight || undefined,
//         tomorrow: data.tomorrow || undefined,
//       });
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Local fallback aligned with Weather section */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     const condition = weather?.celsius?.weather?.[0]?.main;

//     if (!temp) return 'Tap "Generate Suggestions" to get your style advice.';

//     let base = '';
//     if (temp < 40)
//       base =
//         'Very cold — bundle up with heavy layers, a coat, and winter accessories.';
//     else if (temp < 50)
//       base = 'Chilly — layer a knit and a structured jacket for warmth.';
//     else if (temp < 65)
//       base =
//         'Mild and comfortable — a shirt with a light layer works perfectly.';
//     else if (temp < 80)
//       base = 'Warm — breathable fabrics and easy layering pieces shine.';
//     else if (temp < 90) base = 'Hot — keep it light, airy, and minimal.';
//     else
//       base = 'Scorching — ultra-light pieces and maximum ventilation are key.';

//     let extra = '';
//     if (condition === 'Rain')
//       extra = ' ☔ Grab an umbrella or waterproof outer layer.';
//     if (condition === 'Snow')
//       extra = ' ❄️ Insulated footwear and cozy layers recommended.';
//     if (condition === 'Clear') extra = ' 😎 Sunglasses will complete the look.';
//     if (condition === 'Clouds')
//       extra = ' ☁️ Neutrals and light layers are a smart choice.';

//     return `${base}${extra}`;
//   };

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Suggests
//         </Text>
//       </View>

//       {/* 💬 Suggestion or fallback */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 15,
//               fontWeight: '600',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       <View style={{alignItems: 'center'}}>
//         {/* 🔘 Button: Trigger AI manually */}
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 16, width: 230},
//           ]}
//           onPress={fetchSuggestion}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Generate Suggestions
//           </Text>
//         </AppleTouchFeedback>

//         {/* ✨ Only show "Generate Full Look" once AI data is available */}
//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 230},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// import React, {useState} from 'react';
// import {View, Text, TouchableOpacity, ActivityIndicator} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   /** 🧠 Manual fetch — only runs when button pressed */
//   const fetchSuggestion = async () => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log('📦 Payload:', JSON.stringify(payload));
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData({
//         suggestion: data.suggestion || 'Unable to generate a suggestion.',
//         insight: data.insight || undefined,
//         tomorrow: data.tomorrow || undefined,
//       });
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Local fallback if no AI call made */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     if (!temp) return 'Tap "Generate Suggestions" to get your style advice.';
//     if (temp < 60)
//       return 'Cool out — layer a knit under a trench with your loafers.';
//     if (temp > 85) return 'Warm day — go linen trousers and a Cuban shirt.';
//     return 'Perfect weather — chinos, polo, and monk straps.';
//   };

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Suggests
//         </Text>
//       </View>

//       {/* 💬 Suggestion or fallback */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 15,
//               fontWeight: '600',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       <View style={{alignItems: 'center'}}>
//         {/* 🔘 Button: Trigger AI manually */}
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 12, width: 230},
//           ]}
//           onPress={fetchSuggestion}>
//           <Text
//             style={[
//               globalStyles.buttonPrimaryText,
//               {borderRadius: theme.borderRadius.md},
//             ]}>
//             Generate Suggestions
//           </Text>
//         </AppleTouchFeedback>

//         {/* ✨ Only show "Generate Full Look" once AI data is available */}
//         {aiData && (
//           <AppleTouchFeedback
//             hapticStyle="impactHeavy"
//             style={[
//               globalStyles.buttonPrimary,
//               {paddingVertical: 13, marginBottom: 12, width: 210},
//             ]}
//             onPress={() =>
//               navigate('Outfit', {
//                 from: 'AiStylistSuggestions',
//                 seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//                 autogenerate: true,
//               })
//             }>
//             <Text style={globalStyles.buttonPrimaryText}>
//               Generate Full Look
//             </Text>
//           </AppleTouchFeedback>
//         )}
//       </View>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

/////////////////////

// import React, {useState} from 'react';
// import {View, Text, TouchableOpacity, ActivityIndicator} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   /** 🧠 Manual fetch — only runs when button pressed */
//   const fetchSuggestion = async () => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log('📦 Payload:', JSON.stringify(payload));
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData({
//         suggestion: data.suggestion || 'Unable to generate a suggestion.',
//         insight: data.insight || undefined,
//         tomorrow: data.tomorrow || undefined,
//       });
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//   /** 📍 Local fallback if no AI call made */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     if (!temp) return 'Tap "Generate Suggestions" to get your style advice.';
//     if (temp < 60)
//       return 'Cool out — layer a knit under a trench with your loafers.';
//     if (temp > 85) return 'Warm day — go linen trousers and a Cuban shirt.';
//     return 'Perfect weather — chinos, polo, and monk straps.';
//   };

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Suggests
//         </Text>
//       </View>

//       {/* 💬 Suggestion or fallback */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 15,
//               fontWeight: '600',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* 🔘 Button: Trigger AI manually */}
//       <AppleTouchFeedback
//         hapticStyle="impactHeavy"
//         style={[
//           globalStyles.buttonPrimary,
//           {paddingVertical: 13, marginBottom: 12},
//         ]}
//         onPress={fetchSuggestion}>
//         <Text
//           style={[
//             globalStyles.buttonPrimaryText,
//             {borderRadius: theme.borderRadius.md},
//           ]}>
//           Generate Suggestions
//         </Text>
//       </AppleTouchFeedback>

//       {/* ✨ Only show "Generate Full Look" once AI data is available */}
//       {aiData && (
//         <AppleTouchFeedback
//           hapticStyle="impactHeavy"
//           style={[
//             globalStyles.buttonPrimary,
//             {paddingVertical: 13, marginBottom: 12},
//           ]}
//           onPress={() =>
//             navigate('Outfit', {
//               from: 'AiStylistSuggestions',
//               seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//               autogenerate: true,
//             })
//           }>
//           <Text style={globalStyles.buttonPrimaryText}>Generate Full Look</Text>
//         </AppleTouchFeedback>
//       )}

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;

//////////////////////

// /* eslint-disable react-native/no-inline-styles */
// import React, {useEffect, useState} from 'react';
// import {View, Text, TouchableOpacity, ActivityIndicator} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import * as Animatable from 'react-native-animatable';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   theme: any;
//   weather: any;
//   globalStyles: any;
//   navigate: (screen: string, params?: any) => void;
//   userName?: string;
//   wardrobe?: any[];
//   preferences?: any;
// };

// export type AiSuggestionResponse = {
//   suggestion: string;
//   insight?: string;
//   tomorrow?: string;
// };

// const AiStylistSuggestions: React.FC<Props> = ({
//   theme,
//   weather,
//   globalStyles,
//   navigate,
//   userName = 'You',
//   wardrobe = [],
//   preferences = {},
// }) => {
//   const [aiData, setAiData] = useState<AiSuggestionResponse | null>(null);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);

// /** 🧠 Fetch AI suggestion from backend */
// useEffect(() => {
//   const fetchSuggestion = async () => {
//     if (!weather?.fahrenheit?.main?.temp) {
//       console.log('⏸️ Weather not ready, skipping AI fetch.');
//       setLoading(false);
//       return;
//     }

//     // 🧠 Prevent re-fetching endlessly
//     if (aiData) {
//       console.log('✅ AI data already loaded — skipping refetch.');
//       return;
//     }

//     try {
//       setLoading(true);
//       setError(null);

//       const payload = {
//         user: userName,
//         weather,
//         wardrobe,
//         preferences,
//       };

//       console.log('📦 Payload:', JSON.stringify(payload));
//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       console.log('📡 Response status:', res.status);
//       if (!res.ok) throw new Error('Failed to fetch suggestion');

//       const data = await res.json();
//       console.log('✅ AI suggestion data:', data);

//       setAiData({
//         suggestion: data.suggestion || 'Unable to generate a suggestion.',
//         insight: data.insight || undefined,
//         tomorrow: data.tomorrow || undefined,
//       });
//     } catch (err) {
//       console.error(err);
//       setError('Unable to load AI suggestions right now.');
//     } finally {
//       console.log('🛑 Stopping spinner');
//       setLoading(false);
//     }
//   };

//     fetchSuggestion();
//   }, [weather?.fahrenheit?.main?.temp, aiData]);

//   /** 📍 Fallback logic if backend unavailable */
//   const fallbackSuggestion = () => {
//     const temp = weather?.fahrenheit?.main?.temp;
//     if (!temp) return 'Loading your style suggestions...';
//     if (temp < 60)
//       return 'Cool out — layer a knit under a trench with your loafers.';
//     if (temp > 85) return 'Warm day — go linen trousers and a Cuban shirt.';
//     return 'Perfect weather — chinos, polo, and monk straps.';
//   };

//   return (
//     <Animatable.View
//       animation="fadeInUp"
//       delay={200}
//       duration={700}
//       useNativeDriver
//       style={{
//         marginHorizontal: 16,
//         marginBottom: 20,
//         backgroundColor: theme.colors.surface,
//         borderRadius: 16,
//         padding: 18,
//       }}>
//       {/* 🧠 Header */}
//       <View
//         style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
//         <Icon
//           name="stars"
//           size={22}
//           color={theme.colors.button1}
//           style={{marginRight: 8, marginBottom: 6}}
//         />
//         <Text
//           style={{
//             fontSize: 18,
//             fontWeight: '700',
//             color: theme.colors.foreground,
//             textTransform: 'uppercase',
//             marginBottom: 6,
//           }}>
//           AI Stylist Suggests
//         </Text>
//       </View>

//       {/* 💬 Suggestion */}
//       {loading && (
//         <ActivityIndicator
//           color={theme.colors.button1}
//           style={{marginVertical: 20}}
//         />
//       )}

//       {!loading && (
//         <>
//           <Text
//             style={{
//               fontSize: 15,
//               fontWeight: '600',
//               color: theme.colors.foreground,
//               lineHeight: 22,
//               marginBottom: 12,
//             }}>
//             {error
//               ? fallbackSuggestion()
//               : aiData?.suggestion || fallbackSuggestion()}
//           </Text>

//           {/* 📊 Smart Insight */}
//           {aiData?.insight && (
//             <Animatable.Text
//               animation="fadeIn"
//               delay={300}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 fontStyle: 'italic',
//                 marginBottom: 14,
//                 lineHeight: 20,
//               }}>
//               💡 {aiData.insight}
//             </Animatable.Text>
//           )}

//           {/* 📆 Tomorrow Preview */}
//           {aiData?.tomorrow && (
//             <Animatable.Text
//               animation="fadeInUp"
//               delay={400}
//               style={{
//                 fontSize: 15,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//                 lineHeight: 20,
//               }}>
//               📆 Tomorrow: {aiData.tomorrow}
//             </Animatable.Text>
//           )}
//         </>
//       )}

//       {/* ✨ Primary CTA */}
//       <AppleTouchFeedback
//         hapticStyle="impactHeavy"
//         style={[
//           globalStyles.buttonPrimary,
//           {
//             paddingVertical: 13,
//             marginBottom: 12,
//           },
//         ]}
//         onPress={() =>
//           navigate('Outfit', {
//             from: 'AiStylistSuggestions',
//             seedPrompt: aiData?.suggestion || fallbackSuggestion(),
//             autogenerate: true,
//           })
//         }>
//         <Text
//           style={[
//             globalStyles.buttonPrimaryText,
//             {
//               borderRadius: theme.borderRadius.md,
//             },
//           ]}>
//           Generate Full Look
//         </Text>
//       </AppleTouchFeedback>

//       {/* 🔁 Secondary CTAs */}
//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'space-between',
//           marginTop: 8,
//         }}>
//         <TouchableOpacity onPress={() => navigate('Wardrobe')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             View Wardrobe Gaps
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity onPress={() => navigate('AiStylistChatScreen')}>
//           <Text
//             style={{
//               fontSize: 16,
//               fontWeight: '600',
//               color: theme.colors.button1,
//               textDecorationLine: 'underline',
//             }}>
//             Ask a Styling Question →
//           </Text>
//         </TouchableOpacity>
//       </View>
//     </Animatable.View>
//   );
// };

// export default AiStylistSuggestions;
