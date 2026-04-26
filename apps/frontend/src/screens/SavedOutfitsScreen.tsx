import React, {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  Alert,
  TextInput,
  Modal,
  Dimensions,
  Platform,
  Animated,
  Easing,
  ScrollView,
  PanResponder,
  Pressable,
  FlatList,
  TouchableWithoutFeedback,
} from 'react-native';
import {FlashList} from '@shopify/flash-list';
import FastImage from 'react-native-fast-image';
import {BlurView} from '@react-native-community/blur';
import * as Animatable from 'react-native-animatable';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import DateTimePicker from '@react-native-community/datetimepicker';
import ViewShot from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PushNotification from 'react-native-push-notification';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

import {useAppTheme} from '../context/ThemeContext';
import {useFavorites} from '../hooks/useFavorites';
import {useUUID} from '../context/UUIDContext';
import {
  useOutfitsQuery,
  useUpdateOutfit,
  useDeleteOutfit,
  useScheduleOutfit,
  useCancelScheduledOutfit,
  useMarkOutfitWorn,
  useUnmarkOutfitWorn,
  useInvalidateSavedOutfits,
  SavedOutfitData,
} from '../hooks/useOutfitsData';
import {useUserProfile} from '../hooks/useHomeData';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import {addOutfitToCalendar, removeCalendarEvent} from '../utils/calendar';
import {addToInbox} from '../utils/notificationInbox';
import {TooltipBubble} from '../components/ToolTip/ToolTip1';
import SwipeableCard from '../components/SwipeableCard/SwipeableCard';
import {Share} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {useCreatePost} from '../hooks/useCommunityApi';
import {globalNavigate} from '../MainApp';

const {width: SCREEN_WIDTH} = Dimensions.get('window');
const CARD_WIDTH = SCREEN_WIDTH - 32;
const ESTIMATED_CARD_HEIGHT = 320;

// Animated pressable with scale effect for images
const ScalePressable = ({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  style?: any;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}>
      <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

// Occasion types with color coding
type OutfitOccasion =
  | 'Work'
  | 'DateNight'
  | 'Casual'
  | 'Formal'
  | 'Travel'
  | 'Gym'
  | 'Weekend'
  | 'Party'
  | 'Interview'
  | 'Brunch';

// Occasion → Color & Icon mapping
const OCCASION_CONFIG: Record<
  OutfitOccasion,
  {color: string; icon: string; label: string}
> = {
  Work: {color: '#3B82F6', icon: 'work', label: 'Work'},
  DateNight: {color: '#EC4899', icon: 'favorite', label: 'Date Night'},
  Casual: {color: '#22C55E', icon: 'weekend', label: 'Casual'},
  Formal: {color: '#F59E0B', icon: 'star', label: 'Formal'},
  Travel: {color: '#14B8A6', icon: 'flight', label: 'Travel'},
  Gym: {color: '#F97316', icon: 'fitness-center', label: 'Gym'},
  Weekend: {color: '#8B5CF6', icon: 'wb-sunny', label: 'Weekend'},
  Party: {color: '#EF4444', icon: 'celebration', label: 'Party'},
  Interview: {color: '#6366F1', icon: 'business-center', label: 'Interview'},
  Brunch: {color: '#F472B6', icon: 'brunch-dining', label: 'Brunch'},
};

// Use SavedOutfitData from useOutfitsData hook
type SavedOutfit = SavedOutfitData;

const CLOSET_KEY = 'savedOutfits';
const FAVORITES_KEY = 'favoriteOutfits';
const SHEET_MAX_H = Math.min(Dimensions.get('window').height * 0.2, 560);

export default function SavedOutfitsScreen() {
  const userId = useUUID();
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const insets = useSafeAreaInsets();
  const [profilePicture, setProfilePicture] = useState<string>('');

  // TanStack Query: Fetch user profile for name
  const {data: userProfile} = useUserProfile(userId || '');
  const userName =
    `${userProfile?.first_name || ''}${userProfile?.last_name || ''}`.trim() ||
    'StylHelpr';

  // Load profile picture from AsyncStorage
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const cached = await AsyncStorage.getItem(`profile_picture:${userId}`);
      if (cached) {
        setProfilePicture(cached);
      }
    })();
  }, [userId]);

  if (!userId) return null;

  const styles = StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },

    // 🪩 Core Outfit Card
    card: {
       backgroundColor: theme.colors.imageBackground,
      borderRadius: 24,
      padding: 18,
      marginBottom: 6,
      borderWidth: tokens.borderWidth?.md ?? StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 22,
      shadowOffset: {width: 0, height: 10},
      transform: [{scale: 0.98}],
      elevation: 12,
    },

    timestamp: {
      fontSize: 12,
      color: theme.colors.foreground3,
      marginTop: 4,
      marginBottom: 4,
      fontWeight: '500',
      letterSpacing: 0.2,
    },

    actions: {
      flexDirection: 'row',
      alignItems: 'center',
    },

    imageRow: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      // marginTop: 12,
      gap: 12,
    },

    notes: {
      marginTop: 12,
      fontStyle: 'italic',
      color: theme.colors.foreground3,
      fontSize: 14,
      lineHeight: 20,
    },

    stars: {
      flexDirection: 'row',
      marginTop: 6,
    },

    // 🌫️ Overlay for blur modals / pickers
    overlay: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.3)',
    },

    // 📦 Centered modal container
    modalContainer: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'center',
      alignItems: 'center',
    },

    // ✏️ Edit Name / Delete Confirmation Modal
    modalContent: {
      backgroundColor: theme.colors.surface,
      padding: 22,
      borderRadius: 20,
      width: '100%',
      maxWidth: 400,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.surfaceBorder,
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 28,
      shadowOffset: {width: 0, height: 14},
      elevation: 20,
      transform: [{scale: 1}],
    },

    input: {
      marginTop: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.muted,
      paddingVertical: 8,
      color: theme.colors.foreground,
      fontSize: 16,
    },

    modalActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: 20,
      gap: 20,
    },

    // 🪟 Full-screen Outfit Viewer
    fullModalContainer: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'flex-start',
      alignItems: 'center',
      paddingTop: 72,
      paddingHorizontal: 124,
    },

    fullImage: {
      width: '70%',
      aspectRatio: 1,
      marginVertical: 16,
      borderRadius: 18,
      backgroundColor: theme.colors.background,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 24,
      shadowOffset: {width: 0, height: 16},
      elevation: 18,
    },

    // 📅 Bottom Sheet
    sheetContainer: {
      width: '90%',
      backgroundColor: theme.colors.surface3,
      borderRadius: 30,
      paddingTop: 12,
      paddingBottom: Platform.OS === 'ios' ? 16 : 16,
      paddingHorizontal: 20,
      // maxHeight: SHEET_MAX_H,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 32,
      shadowOffset: {width: 0, height: -14},
      elevation: 26,
    },

    grabber: {
      alignSelf: 'center',
      width: 50,
      height: 6,
      borderRadius: 3,
      backgroundColor: 'rgba(255,255,255,0.25)',
      marginBottom: 12,
    },

    sheetHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
      paddingHorizontal: 4,
    },

    sheetTitle: {
      fontSize: 18,
      fontWeight: '800',
      color: theme.colors.foreground,
      letterSpacing: 0.3,
    },

    sheetPill: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 22,
      backgroundColor: theme.colors.input2 ?? 'rgba(43,43,43,1)',
    },

    sheetPillText: {
      color: theme.colors.foreground3 ?? '#EAEAEA',
      fontWeight: '700',
      letterSpacing: 0.2,
    },

    sheetFooterRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 6,
      marginTop: 14,
      marginBottom: 10,
    },

    // 🍞 Toast
    toast: {
      position: 'absolute',
      bottom: 30,
      left: 20,
      right: 20,
      backgroundColor: theme.colors.surface,
      paddingVertical: 14,
      paddingHorizontal: 18,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 20,
      shadowOffset: {width: 0, height: 10},
      elevation: 20,
    },
  });

  // 🧠 State Management
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Load persisted view mode
  useEffect(() => {
    AsyncStorage.getItem('saved_outfits_view_mode').then(val => {
      if (val === 'list' || val === 'grid') {
        setViewMode(val);
      }
    });
  }, []);

  // Persist view mode on change
  useEffect(() => {
    AsyncStorage.setItem('saved_outfits_view_mode', viewMode);
  }, [viewMode]);

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'sort' | 'filter'>('main');
  const submenuOpacity = useRef(new Animated.Value(0)).current;
  const [editingOutfitId, setEditingOutfitId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [editedOccasion, setEditedOccasion] = useState<
    OutfitOccasion | undefined
  >(undefined);

  // Demo outfit state - tracks if user has ever had real saved outfits
  const [hasEverHadOutfits, setHasEverHadOutfits] = useState<boolean | null>(
    null,
  );

  // Demo outfit items (using bundled wardrobe assets)
  const demoOutfits: SavedOutfit[] = [
    {
      id: 'demo-outfit-1',
      name: 'Upscale Style 1',
      type: 'custom',
      top: {
        id: 'demo-top',
        name: 'Cable Knit Sweater',
        image: Image.resolveAssetSource(
          require('../assets/images/top-sweater1.png'),
        ).uri,
      },
      bottom: {
        id: 'demo-bottom',
        name: 'Classic Blue Jeans',
        image: Image.resolveAssetSource(
          require('../assets/images/bottoms-jeans1.png'),
        ).uri,
      },
      shoes: {
        id: 'demo-shoes',
        name: 'Black Leather Loafers',
        image: Image.resolveAssetSource(
          require('../assets/images/shoes-loafers1.jpg'),
        ).uri,
      },
      createdAt: new Date().toISOString(),
      occasion: 'DateNight',
      favorited: true,
      tags: [],
    },
  ];

  // Load hasEverHadOutfits flag from AsyncStorage
  useEffect(() => {
    const loadDemoFlag = async () => {
      try {
        const hasOutfits = await AsyncStorage.getItem('saved_outfits_has_real');
        setHasEverHadOutfits(hasOutfits === 'true');
      } catch (err) {
        console.error('Failed to load saved outfits demo flag:', err);
        setHasEverHadOutfits(false);
      }
    };
    loadDemoFlag();
  }, []);

  // Occasion filter state (null = "All")
  const [occasionFilter, setOccasionFilter] = useState<OutfitOccasion | null>(
    null,
  );

  const [planningOutfitId, setPlanningOutfitId] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [selectedTempDate, setSelectedTempDate] = useState<Date | null>(null);
  const [selectedTempTime, setSelectedTempTime] = useState<Date | null>(null);
  const [lastDeletedOutfit, setLastDeletedOutfit] =
    useState<SavedOutfit | null>(null);

  const {
    favorites,
    isLoading: favoritesLoading,
    toggleFavorite,
  } = useFavorites(userId);

  // TanStack Query: Fetch outfits with caching
  const {
    data: combinedOutfits = [],
    isLoading: outfitsLoading,
    refetch: refetchOutfits,
  } = useOutfitsQuery(userId, favorites);

  // Update hasEverHadOutfits when real content appears
  useEffect(() => {
    if (
      combinedOutfits &&
      combinedOutfits.length > 0 &&
      hasEverHadOutfits === false
    ) {
      setHasEverHadOutfits(true);
      AsyncStorage.setItem('saved_outfits_has_real', 'true');
    }
  }, [combinedOutfits, hasEverHadOutfits]);

  // Compute outfits state: 'demo' | 'real' | 'empty-real'
  const outfitsState =
    combinedOutfits && combinedOutfits.length > 0
      ? 'real'
      : hasEverHadOutfits
        ? 'empty-real'
        : 'demo';

  // Use demo outfits when in demo state, otherwise use real outfits
  const displayOutfits =
    outfitsState === 'demo' ? demoOutfits : combinedOutfits;

  // console.log('🎨 SavedOutfits render:', {
  //   outfitsState,
  //   combinedOutfitsCount: combinedOutfits?.length,
  //   displayOutfitsCount: displayOutfits?.length,
  //   hasEverHadOutfits,
  // });

  // TanStack Query: Mutations
  const updateOutfitMutation = useUpdateOutfit();
  const deleteOutfitMutation = useDeleteOutfit();
  const scheduleOutfitMutation = useScheduleOutfit();
  const cancelScheduledOutfitMutation = useCancelScheduledOutfit();
  const markWornMutation = useMarkOutfitWorn();
  const unmarkWornMutation = useUnmarkOutfitWorn();
  const invalidateSavedOutfits = useInvalidateSavedOutfits();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const datePickerRef = useRef<Animatable.View & View>(null);

  const viewRefs = useRef<{[key: string]: ViewShot | null}>({});
  const [fullScreenOutfit, setFullScreenOutfit] = useState<SavedOutfit | null>(
    null,
  );
  const displayedOutfitRef = useRef<SavedOutfit | null>(null);

  // FlashList ref for scroll-to-top
  const flashListRef = useRef<any>(null);

  const screenH = Dimensions.get('window').height;
  const translateY = useRef(new Animated.Value(screenH)).current;

  useEffect(() => {
    if (fullScreenOutfit) {
      // 🟢 Animate up from offscreen only when opening
      Animated.timing(translateY, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [fullScreenOutfit]);

  const handleClose = useCallback(() => {
    // 🧠 just trigger the modal to close
    setFullScreenOutfit(null);
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 8,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 100 || g.vy > 0.3) {
          handleClose();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  const hSelect = () =>
    ReactNativeHapticFeedback.trigger('selection', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });

  // ⏱️ Utility: Combine date + time
  const combineDateAndTime = (date: Date, time: Date) => {
    const d = new Date(date);
    const t = new Date(time);
    d.setHours(t.getHours(), t.getMinutes(), 0, 0);
    return d;
  };

  // Ref for the share composite ViewShot
  const shareCompositeRef = useRef<ViewShot>(null);
  const [shareOutfit, setShareOutfit] = useState<SavedOutfit | null>(null);
  const [shareOptionsVisible, setShareOptionsVisible] = useState(false);
  const [pendingShareOutfit, setPendingShareOutfit] =
    useState<SavedOutfit | null>(null);
  const [communityShareModalVisible, setCommunityShareModalVisible] =
    useState(false);
  const [communityDescription, setCommunityDescription] = useState('');
  const [communityTags, setCommunityTags] = useState('');

  // Community post mutation
  const createPostMutation = useCreatePost();

  // Show share options when user taps share button
  const handleSharePress = (outfit: SavedOutfit) => {
    ReactNativeHapticFeedback.trigger('impactLight', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
    setPendingShareOutfit(outfit);
    setShareOptionsVisible(true);
  };

  // Share to Community
  const handleShareToCommunity = async () => {
    if (!pendingShareOutfit || !userId) return;

    setShareOptionsVisible(false);
    setCommunityDescription('');
    setCommunityTags('');
    setCommunityShareModalVisible(true);
  };

  const handleConfirmCommunityShare = async () => {
    if (!pendingShareOutfit || !userId) return;

    try {
      ReactNativeHapticFeedback.trigger('impactMedium', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });

      const tagsArray = communityTags
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

      const outfitName =
        communityDescription || pendingShareOutfit.name || 'My outfit';
      // Note: userId is extracted from JWT token on backend, not sent in body
      await createPostMutation.mutateAsync({
        imageUrl: pendingShareOutfit.thumbnailUrl || undefined,
        topImage: pendingShareOutfit.top?.image,
        bottomImage: pendingShareOutfit.bottom?.image,
        shoesImage: pendingShareOutfit.shoes?.image,
        name: outfitName,
        description: '',
        tags: tagsArray.length > 0 ? tagsArray : ['outfit'],
      });

      setCommunityShareModalVisible(false);
      setPendingShareOutfit(null);
      Alert.alert('Success', 'Your outfit has been shared to the community!');
    } catch (error) {
      console.error('Failed to share to community:', error);
      Alert.alert('Error', 'Failed to share to community. Please try again.');
    }
  };

  // Share externally via native share sheet
  const handleShareExternal = async () => {
    setShareOptionsVisible(false);
    if (pendingShareOutfit) {
      await handleShareOutfit(pendingShareOutfit);
      setPendingShareOutfit(null);
    }
  };

  const handleShareOutfit = async (outfit: SavedOutfit) => {
    try {
      // ✅ subtle tap
      ReactNativeHapticFeedback.trigger('impactLight', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });

      // Preload profile picture if available
      if (profilePicture) {
        await Image.prefetch(profilePicture);
      }

      // Set the outfit to render the composite
      setShareOutfit(outfit);

      // Wait for the composite to render
      await new Promise(resolve => setTimeout(resolve, 300));

      // Capture the 2x2 grid composite
      if (!shareCompositeRef.current) {
        throw new Error('Share composite ref not ready');
      }

      const compositeUri = await shareCompositeRef.current.capture?.();

      // 📨 open native iOS share sheet
      await Share.share({
        url: compositeUri,
        message: `Check out my outfit "${outfit.name || ''}" via StylHelpr`,
        title: 'Share Your Look',
      });

      // Clear the share outfit
      setShareOutfit(null);
    } catch (err) {
      console.error('Error sharing look:', err);
      setShareOutfit(null);
    }
  };

  const handleNameSave = async () => {
    if (!editingOutfitId) return;

    const outfit = combinedOutfits.find(o => o.id === editingOutfitId);
    if (!outfit) return;

    // Use TanStack Query mutation (optimistic update handled in hook)
    updateOutfitMutation.mutate(
      {
        userId,
        outfitId: editingOutfitId,
        outfitType: outfit.type,
        name: editedName.trim() || outfit.name,
        occasion: editedOccasion ?? null,
      },
      {
        onSuccess: () => {
          // Reset modal state on success
          setEditingOutfitId(null);
          setEditedName('');
          setEditedOccasion(undefined);
        },
        onError: err => {
          console.error('Error updating outfit:', err);
          Alert.alert('Error', 'Failed to update outfit in the database.');
        },
      },
    );
  };

  // ✅ Delete outfit using TanStack Query mutation
  const handleDelete = (id: string) => {
    const deleted = combinedOutfits.find(o => o.id === id);
    if (!deleted) return;

    // Store for undo toast before optimistic delete
    setLastDeletedOutfit(deleted);
    setTimeout(() => setLastDeletedOutfit(null), 3000);

    deleteOutfitMutation.mutate(
      {userId, outfitId: id},
      {
        onError: err => {
          console.error('Error deleting outfit:', err);
          Alert.alert('Error', 'Could not delete outfit from the database.');
          setLastDeletedOutfit(null);
        },
      },
    );
  };

  // 📅 Local notification helpers
  const scheduleOutfitLocalAlert = async (
    outfitId: string,
    outfitName: string | undefined,
    when: Date,
  ) => {
    const title = 'Outfit Reminder';
    const message = `Wear ${outfitName?.trim() || 'your planned outfit'}`;

    // console.log('🔔 Scheduling notification:', {
    //   outfitId,
    //   when: when.toISOString(),
    //   whenLocal: when.toLocaleString(),
    //   now: new Date().toISOString(),
    //   nowLocal: new Date().toLocaleString(),
    // });

    // @ts-ignore - id property exists but types may be outdated
    PushNotification.localNotificationSchedule({
      id: `outfit-${outfitId}`,
      channelId: 'style-channel',
      title,
      message,
      date: when,
      allowWhileIdle: true,
      playSound: true,
      soundName: 'default',
    });

    // Also add to notification inbox so it shows in NotificationsScreen
    await addToInbox(userId, {
      user_id: userId,
      id: `outfit-${outfitId}`,
      title,
      message,
      timestamp: when.toISOString(),
      category: 'outfit',
      data: {screen: 'Planner'},
      read: false,
    });
  };

  // 👇 Custom slide-in-from-right animation
  const slideInFromRight = {
    from: {opacity: 0, translateX: 80},
    to: {opacity: 1, translateX: 0},
  };

  // 🔄 Reset all scheduling state (Close / Cancel handlers)

  

  const resetPlanFlow = async () => {
    if (datePickerRef.current) {
      await (datePickerRef.current as any).animate(
        {
          from: {opacity: 1, translateY: 0, scale: 1},
          to: {opacity: 0, translateY: 60, scale: 0.97},
        },
        400,
      );
    }
    setPlanningOutfitId(null);
    setShowDatePicker(false);
    setShowTimePicker(false);
    setSelectedTempDate(null);
    setSelectedTempTime(null);
  };

  const commitSchedule = async () => {
    if (!planningOutfitId || !selectedTempDate || !selectedTempTime) return;
    try {
      const selectedOutfit = combinedOutfits.find(
        o => o.id === planningOutfitId,
      );
      if (!selectedOutfit) return;

      const outfit_type = selectedOutfit.type === 'custom' ? 'custom' : 'ai';
      const combined = combineDateAndTime(selectedTempDate, selectedTempTime);

      // clear any previous local alert + calendar event
      cancelOutfitLocalAlert(planningOutfitId);
      const oldKey = `outfitCalendar:${planningOutfitId}`;
      const oldEventId = await AsyncStorage.getItem(oldKey);
      if (oldEventId) {
        await removeCalendarEvent(oldEventId);
        await AsyncStorage.removeItem(oldKey);
      }

      // Save to server using TanStack Query mutation (optimistic update in hook)
      scheduleOutfitMutation.mutate({
        userId,
        outfitId: planningOutfitId,
        outfitType: outfit_type,
        scheduledFor: combined.toISOString(),
      });

      // local notification + add to inbox
      await scheduleOutfitLocalAlert(
        planningOutfitId,
        selectedOutfit.name,
        combined,
      );

      // add to calendar & remember event id
      const eventId = await addOutfitToCalendar({
        title: selectedOutfit.name?.trim() || 'Outfit',
        startISO: combined.toISOString(),
        notes: selectedOutfit.notes || '',
        alarmMinutesBefore: 0,
      });
      if (eventId) {
        await AsyncStorage.setItem(
          `outfitCalendar:${planningOutfitId}`,
          eventId,
        );
      }
    } catch (err) {
      console.error('Failed to schedule outfit:', err);
    } finally {
      resetPlanFlow();
    }
  };

  const cancelPlannedOutfit = async (outfitId: string) => {
    // Cancel local alert first
    cancelOutfitLocalAlert(outfitId);

    // Remove calendar event (if any)
    const key = `outfitCalendar:${outfitId}`;
    const existingId = await AsyncStorage.getItem(key);
    if (existingId) {
      await removeCalendarEvent(existingId);
      await AsyncStorage.removeItem(key);
    }

    // Use TanStack Query mutation (optimistic update in hook)
    cancelScheduledOutfitMutation.mutate(
      {userId, outfitId},
      {
        onError: err => {
          console.error('Failed to cancel plan:', err);
          Alert.alert('Error', 'Could not cancel the planned date.');
        },
      },
    );
  };

  const cancelOutfitLocalAlert = (outfitId: string) => {
    // @ts-ignore - cancelLocalNotification exists but types are outdated
    PushNotification.cancelLocalNotification(`outfit-${outfitId}`);
  };

  // Check for schedule changes when component mounts or userId changes
  // This handles updates made from CalendarPlannerScreen
  const [lastScheduleCheck, setLastScheduleCheck] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const checkScheduleChanges = async () => {
      const changed = await AsyncStorage.getItem('schedulesChanged');
      if (changed && changed !== lastScheduleCheck) {
        setLastScheduleCheck(changed);
        // Invalidate TanStack Query cache to refetch
        invalidateSavedOutfits(userId);
      }
    };
    checkScheduleChanges();
    // Also check periodically when screen is visible
    const interval = setInterval(checkScheduleChanges, 1000);
    return () => clearInterval(interval);
  }, [userId, lastScheduleCheck, invalidateSavedOutfits]);

  // ✨ Sort state and computed outfits
  const [sortType, setSortType] = useState<
    'newest' | 'favorites' | 'planned' | 'stars'
  >('newest');

  // Filter by occasion first, then sort
  const sortedOutfits = useMemo(() => {
    const filteredOutfits = occasionFilter
      ? displayOutfits.filter(o => o.occasion === occasionFilter)
      : displayOutfits;

    return [...filteredOutfits].sort((a, b) => {
      switch (sortType) {
        case 'favorites':
          return Number(b.favorited) - Number(a.favorited);
        case 'planned':
          return (
            new Date(b.plannedDate || 0).getTime() -
            new Date(a.plannedDate || 0).getTime()
          );
        case 'stars':
          return (b.rating || 0) - (a.rating || 0);
        default:
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
      }
    });
  }, [displayOutfits, occasionFilter, sortType]);

  // console.log('🎨 sortedOutfits:', {
  //   sortedCount: sortedOutfits?.length,
  //   occasionFilter,
  //   sortType,
  // });

  // Handle scroll for bottom nav hide/show
  const handleScroll = useCallback(
    (event: {nativeEvent: {contentOffset: {y: number}}}) => {
      if (global.__navScrollY) {
        global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
      }
    },
    [],
  );

  // Share composite card size (matches community grid)
  const SHARE_SIZE = 400;
  const SHARE_CELL = SHARE_SIZE / 2;

  // Memoized render item for FlashList
  const renderOutfitItem = useCallback(
    ({item: outfit, index}: {item: SavedOutfit; index: number}) => {
      const isDemo = outfit.id.startsWith('demo-');

      // For demo items, render matching the real card layout exactly
      if (isDemo) {
        return (
          <View style={{paddingHorizontal: 6}}>
            <View style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
              {/* 🧵 Outfit Header Row */}
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                <View style={{flex: 1, marginRight: 12}}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}>
                    <Text
                      style={[
                        globalStyles.titleBold,
                        {
                          fontSize: 20,
                          color: theme.colors.foreground,
                        },
                      ]}>
                      {outfit.name?.trim() || 'Unnamed Outfit'}
                    </Text>
                    <View
                      style={{
                        backgroundColor: 'black',
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 6,
                      }}>
                      <Text
                        style={{
                          color: 'white',
                          fontSize: 11,
                          fontWeight: tokens.fontWeight.semiBold,
                        }}>
                        Sample
                      </Text>
                    </View>
                  </View>

                  {/* Date info */}
                  <View style={{marginTop: 6}}>
                    <Text
                      style={[
                        styles.timestamp,
                        {
                          fontSize: 13,
                          fontWeight: '600',
                          color: theme.colors.foreground2,
                        },
                      ]}>
                      Planned for Oct 5 at 10:14 AM
                    </Text>
                    <Text
                      style={[
                        styles.timestamp,
                        {
                          fontSize: 12,
                          color: theme.colors.muted,
                        },
                      ]}>
                      Saved Sep 18, 2025
                    </Text>
                  </View>
                </View>

                {/* ✏️ & ❤️ & 📤 Buttons (visual only) */}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}>
                  {/* ✏️ Edit */}
                  <View
                    style={{
                      padding: 8,
                      borderRadius: 14,
                      backgroundColor:
                        theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                      marginRight: 6,
                    }}>
                    <MaterialIcons
                      name="edit"
                      size={20}
                      color={theme.colors.foreground}
                    />
                  </View>

                  {/* ❤️ Favorite */}
                  <View
                    style={{
                      padding: 8,
                      borderRadius: 14,
                      backgroundColor:
                        theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                    }}>
                    <MaterialIcons name="favorite" size={20} color="red" />
                  </View>

                  {/* 📤 Share */}
                  <View
                    style={{
                      padding: 8,
                      borderRadius: 14,
                      backgroundColor:
                        theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                      marginLeft: 6,
                    }}>
                    <MaterialIcons
                      name="ios-share"
                      size={20}
                      color={theme.colors.primary}
                    />
                  </View>
                </View>
              </View>

              {/* 👕 Outfit Images - centered thumbnail */}
              <View style={{alignItems: 'center', marginVertical: 10}}>
                {outfit.thumbnailUrl ? (
                  <View style={{
                    width: '100%',
                    height: 300,
                    borderRadius: 12,
                    overflow: 'hidden',
                    backgroundColor: theme.colors.surface,
                  }}>
                    <FastImage
                      source={{
                        uri: outfit.thumbnailUrl,
                        priority: FastImage.priority.normal,
                        cache: FastImage.cacheControl.web,
                      }}
                      style={{
                        width: '100%',
                        height: 300,
                        borderRadius: tokens.borderRadius.switch1
                      }}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  </View>
                  
                ) : (

                  <View style={{flexDirection: 'row', justifyContent: 'center', gap: 12}}>
                    {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
                      i?.image ? (
                        <FastImage
                          key={i.id || idx}
                          source={{
                            uri: i.image,
                            priority: FastImage.priority.normal,
                            cache: FastImage.cacheControl.web,
                          }}
                          style={[
                            globalStyles.image1,
                            {
                              marginRight: 2,
                              borderRadius: 8,
                              marginBottom: 8,
                              marginTop: -6,
                            },
                          ]}
                          resizeMode={FastImage.resizeMode.contain}
                        />
                      ) : null,
                    )}
                  </View>
                )}
              </View>

              {/* Worn count & Occasion chip row */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                }}>
                {/* Left 50% - Worn button & count */}
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}>
                  <View
                    style={{
                      paddingVertical: 4.5,
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      backgroundColor:
                        theme.colors.button1 ?? 'rgba(43,43,43,1)',
                    }}>
                    <MaterialIcons
                      name="checkroom"
                      size={2}
                      color={theme.colors.buttonText1}
                    />
                  </View>

                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: theme.colors.surface,
                      paddingHorizontal: 9,
                      borderRadius: 12,
                    }}>
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: '700',
                        color: theme.colors.foreground,
                      }}>
                      Worn:11 x{' '}
                    </Text>
                  </View>
                </View>

                {/* Right 50% - Occasion Chip */}
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                  }}>
                  {outfit.occasion && OCCASION_CONFIG[outfit.occasion] ? (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: OCCASION_CONFIG[outfit.occasion].color,
                        paddingHorizontal: 14,
                        paddingVertical: 9,
                        borderRadius: 50,
                      }}>
                      <MaterialIcons
                        name={OCCASION_CONFIG[outfit.occasion].icon as any}
                        size={14}
                        color={theme.colors.foreground}
                        style={{marginRight: 5}}
                      />
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color: theme.colors.foreground,
                        }}>
                        {OCCASION_CONFIG[outfit.occasion].label}
                      </Text>
                    </View>
                  ) : (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: theme.colors.surface3,
                        paddingHorizontal: 14,
                        paddingVertical: 9,
                        borderRadius: 50,
                      }}>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color: theme.colors.foreground3,
                        }}>
                        ✕ None
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              {/* Schedule & Cancel buttons */}
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-start',
                  flexWrap: 'wrap',
                  marginTop: 8,
                }}>
                <View
                  style={{
                    backgroundColor: theme.colors.button1,
                    borderRadius: 8,
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                    marginRight: 10,
                  }}>
                  <Text
                    style={{
                      color: theme.colors.buttonText1,
                      fontWeight: '600',
                      fontSize: 13,
                    }}>
                    Schedule This Outfit
                  </Text>
                </View>

                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 8.5,
                    paddingHorizontal: 14,
                    borderRadius: 8,
                    backgroundColor:
                      theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                  }}>
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontWeight: '600',
                      fontSize: 13,
                    }}>
                    Cancel Schedule
                  </Text>
                </View>
              </View>

              {/* Tags */}
              {(outfit.tags || []).length > 0 && (
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    marginTop: 8,
                  }}>
                  {outfit.tags?.map(tag => (
                    <View
                      key={tag}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        backgroundColor:
                          theme.colors.input2 ?? 'rgba(43,43,43,1)',
                        borderRadius: 16,
                        marginRight: 6,
                        marginBottom: 6,
                      }}>
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.colors.foreground,
                        }}>
                        #{tag}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            <Text
              style={{
                fontSize: 12,
                color: theme.colors.foreground2,
               
                textAlign: 'center',
              }}>
              Saved outfit cards will appear here ^
            </Text>
          </View>
        );
      }

      return (
        <SwipeableCard
          key={outfit.id}
          deleteThreshold={0.15}
          onSwipeLeft={() => {
            setPendingDeleteId(outfit.id);
            setShowDeleteConfirm(true);
          }}
          deleteBackground={
            <View
              style={{
                flex: 1,
                alignItems: 'flex-end',
                justifyContent: 'center',
                paddingRight: 24,
              }}
            />
          }>
          <View style={{paddingHorizontal: 6}}>
            <ViewShot
              ref={ref => {
                viewRefs.current[outfit.id] = ref;
              }}
              options={{format: 'png', quality: 0.9}}>

              <ScalePressable
                onPress={() => setFullScreenOutfit(outfit)}
                style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
                {/* 🧵 Outfit Header Row */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                  <View style={{flex: 1, marginRight: 12}}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}>
                      <Text
                        style={[
                          globalStyles.titleBold,
                          {
                            fontSize: 20,
                            color: theme.colors.foreground,
                            flex: 1,
                          },
                        ]}>
                        {outfit.name?.trim() || 'Unnamed Outfit'}
                      </Text>
                    </View>

                    {/* 🗓️ Date & Time Info */}
                    {(outfit.createdAt || outfit.plannedDate) && (
                      <View style={{marginTop: 6}}>
                        {outfit.plannedDate && (
                          <Text
                            style={[
                              styles.timestamp,
                              {
                                fontSize: 13,
                                fontWeight: '600',
                                color: theme.colors.foreground2,
                              },
                            ]}>
                            {`Planned for ${new Date(
                              outfit.plannedDate,
                            ).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}`}
                          </Text>
                        )}
                        {outfit.createdAt && (
                          <Text
                            style={[
                              styles.timestamp,
                              {
                                fontSize: 12,
                                color: theme.colors.muted,
                              },
                            ]}>
                            {`Saved ${new Date(
                              outfit.createdAt,
                            ).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}`}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>

        
                  
                </View>

                {/* Two-column layout: thumbnail left, controls right */}
                <View style={{flexDirection: 'row', marginVertical: 0}}>
                  
                  {/* Left column – Thumbnail */}
                  <View style={{width: '46%'}}>
                    {outfit.thumbnailUrl ? (
                      <View style={{
                        width: '100%',
                        height: 185,
                        borderRadius: tokens.borderRadius.switch1,
                        overflow: 'hidden',
                        marginTop: 6
                      }}>
                        <View style={{
                          flex: 1,
                           backgroundColor: theme.colors.imageBackground     
                        }}>
                          <FastImage
                            source={{
                              uri: outfit.thumbnailUrl,
                              priority: FastImage.priority.normal,
                              cache: FastImage.cacheControl.web,
                            }}
                            style={{
                              width: '100%',
                              height: '100%',
                              borderRadius: tokens.borderRadius.switch1,
                            }}
                            resizeMode={FastImage.resizeMode.contain}
                          />
                        </View>
                      </View>
                    ) : (
                      <View style={{flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6}}>
                        {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
                          i?.image ? (
                            <FastImage
                              key={i.id || idx}
                              source={{
                                uri: i.image,
                                priority: FastImage.priority.normal,
                                cache: FastImage.cacheControl.web,
                              }}
                              style={[
                                globalStyles.image1,
                                {
                                  marginRight: 2,
                                  borderRadius: tokens.borderRadius.switch1,
                                  marginBottom: 4,
                                },
                              ]}
                              resizeMode={FastImage.resizeMode.contain}
                            />
                          ) : null,
                        )}
                      </View>
                    )}
                  </View>

              {/* Right column – Controls */}
              <View style={{flex: 1, marginLeft: 10, marginTop: 4}}>
                    
                {/* ❤️ & ✏️ & 👕 Buttons */}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      marginBottom: 2
                    }}>

                    {/* ✏️ Edit */}
                    <Pressable
                      onPress={() => {
                        hSelect();
                        setEditingOutfitId(outfit.id);
                        setEditedName(outfit.name || '');
                        setEditedOccasion(outfit.occasion);
                      }}
                      style={{
                        padding: 8,
                        borderRadius: 14,
                        backgroundColor:
                          theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                        marginRight: 6,
                      }}>
                      <MaterialIcons
                        name="edit"
                        size={20}
                        color={theme.colors.foreground}
                      />
                    </Pressable>

                    {/* ❤️ Favorite */}
                    <Pressable
                      onPress={() => {
                        hSelect();
                        toggleFavorite(
                          outfit.id,
                          outfit.type === 'custom' ? 'custom' : 'suggestion',
                        );
                      }}
                      style={{
                        padding: 8,
                        borderRadius: 14,
                        backgroundColor:
                          theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                      }}>
                      <MaterialIcons
                        name="favorite"
                        size={20}
                        color={
                          favorites.some(
                            f =>
                              f.id === outfit.id &&
                              f.source ===
                                (outfit.type === 'custom'
                                  ? 'custom'
                                  : 'suggestion'),
                          )
                            ? 'red'
                            : theme.colors.foreground
                        }
                      />
                    </Pressable>

                    {/* 📤 Share */}
                    <Pressable
                      onPress={() => handleSharePress(outfit)}
                      style={{
                        padding: 8,
                        borderRadius: 14,
                        backgroundColor:
                          theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                        marginLeft: 6,
                      }}>
                      <MaterialIcons
                        name="ios-share"
                        size={20}
                        color={theme.colors.primary}
                      />
                    </Pressable>

                    {/* 👕 Mark as worn (tap to increment, long press to decrement) */}
                      <Pressable
                        onPress={() => {
                          hSelect();
                          markWornMutation.mutate({
                            userId,
                            outfitId: outfit.id,
                            outfitType: outfit.type,
                          });
                        }}
                        onLongPress={() => {
                          if ((outfit.timesWorn ?? 0) <= 0) return;
                          hSelect();
                          unmarkWornMutation.mutate({
                            userId,
                            outfitId: outfit.id,
                            outfitType: outfit.type,
                          });
                        }}
                        delayLongPress={500}
                        style={{
                          paddingVertical: 5.5,
                          borderRadius: 14,
                          paddingHorizontal: 8,
                          marginLeft: 6,
                          backgroundColor:
                            theme.colors.button1 ?? 'rgba(43,43,43,1)',
                        }}>
                        <MaterialIcons
                          name="checkroom"
                          size={22}
                          color={theme.colors.buttonText1}
                        />
                      </Pressable>
                  </View>

                    {/* Worn & Occasion row */}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                  
                      }}>
                        <Text
                           style={{
                              fontSize: 16,
                              fontWeight: '700',
                              color: theme.colors.foreground,
                              marginBottom: 4
                            }}>
                             {`Worn: `} 
                        </Text>
                      {(outfit.timesWorn ?? 0) > 0 && (
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                      
                          }}>
                          <Text
                            style={{
                              fontSize: 16,
                              fontWeight: '700',
                              color: theme.colors.foreground,
                            }}>
                            {outfit.timesWorn} times{' '}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Occasion Chip */}
                        <View style={{ height: 45, alignItems: 'flex-start',}}>
                      {outfit.occasion && OCCASION_CONFIG[outfit.occasion] ? (
                        <Pressable
                          onPress={() => {
                            hSelect();
                            setEditingOutfitId(outfit.id);
                            setEditedName(outfit.name || '');
                            setEditedOccasion(outfit.occasion);
                          }}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            alignSelf: 'flex-start',
                            backgroundColor: `${
                              OCCASION_CONFIG[outfit.occasion].color
                            }`,
                            paddingHorizontal: 14,
                            paddingVertical: 9,
                            borderRadius: 50,
                            marginTop: 4
                          }}>
                          <MaterialIcons
                            name={OCCASION_CONFIG[outfit.occasion].icon as any}
                            size={14}
                            color={theme.colors.foreground}
                            style={{marginRight: 5}}
                          />
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color: theme.colors.foreground,
                            }}>
                            {OCCASION_CONFIG[outfit.occasion].label}
                          </Text>
                        </Pressable>
                      ) : (
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            alignSelf: 'flex-start',
                            backgroundColor: theme.colors.surface3,
                            paddingHorizontal: 14,
                            paddingVertical: 9,
                            borderRadius: 50,
                            marginTop: 4,
                          }}>
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color: theme.colors.foreground3,
                            }}>
                            ✕ None
                          </Text>
                        </View>
                      )}
                          </View>

                    {/* 📅 Schedule & Cancel Buttons – keep them working */}
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        // marginTop: 8,
                        gap: 8,
                      }}>
                      <AppleTouchFeedback
                        hapticStyle="impactLight"
                        onPress={() => {
                          setPlanningOutfitId(outfit.id);
                          const now = new Date();
                          setSelectedTempDate(now);
                          setSelectedTempTime(now);
                          setShowDatePicker(true);
                        }}
                        style={{
                          backgroundColor: theme.colors.button1,
                          borderRadius: 8,
                          paddingVertical: 8,
                          width: 160,
                          marginTop: 2,
                        }}>
                        <Text
                          style={{
                            color: theme.colors.buttonText1,
                            fontWeight: '600',
                            fontSize: 13,
                            textAlign: 'center'
                          }}>
                          Schedule This Outfit
                        </Text>
                      </AppleTouchFeedback>

                      {outfit.plannedDate && (
                        <AppleTouchFeedback
                          hapticStyle="impactLight"
                          onPress={() => {
                            cancelPlannedOutfit(outfit.id);
                          }}
                          style={{
                            marginTop: 4,
                            paddingVertical: 8.5,
                            width: 160,
                            borderRadius: 8,
                            borderColor: theme.colors.muted,
                            borderWidth: tokens.borderWidth.hairline,
                          }}>
                          <Text
                            style={{
                            color: theme.colors.foreground,
                            fontWeight: '600',
                            fontSize: 13,
                            textAlign: 'center'
                            }}>
                            Cancel Schedule
                          </Text>
                        </AppleTouchFeedback>
                      )}
                    </View>
                    
                    {/* 🏷️ Tags */}
                    {(outfit.tags || []).length > 0 && (
                      <View
                        style={{
                          flexDirection: 'row',
                          flexWrap: 'wrap',
                          marginTop: 8,
                        }}>
                        {outfit.tags?.map(tag => (
                          <View
                            key={tag}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              backgroundColor:
                                theme.colors.input2 ?? 'rgba(43,43,43,1)',
                              borderRadius: 16,
                              marginRight: 6,
                              marginBottom: 6,
                            }}>
                            <Text
                              style={{
                                fontSize: 12,
                                color: theme.colors.foreground,
                              }}>
                              #{tag}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </View>

                {/* 📝 Notes */}
                {outfit.notes?.trim() && (
                  <Text style={styles.notes}>"{outfit.notes.trim()}"</Text>
                )}
              </ScalePressable>
            </ViewShot>
          </View>
        </SwipeableCard>
      );
    },
    [
      favorites,
      theme,
      globalStyles,
      styles,
      userId,
      toggleFavorite,
      markWornMutation,
      unmarkWornMutation,
      outfitsState,
    ],
  );

  const keyExtractor = useCallback((item: SavedOutfit) => item.id, []);

  // Override item layout for FlashList optimization
  const overrideItemLayout = useCallback(
    (layout: {span?: number; size?: number}): void => {
      layout.size = ESTIMATED_CARD_HEIGHT;
    },
    [],
  );

  // 🔲 Grid View: minimal 2-column thumbnail + name only /
  // Sized so exactly 3 rows are visible on screen
  const GRID_GAP = 0;
  const GRID_PADDING_H = 10;
  const GRID_ITEM_WIDTH = (SCREEN_WIDTH - GRID_PADDING_H * 2 - GRID_GAP) / 2;
  const GRID_VISIBLE_ROWS = 3;
  const GRID_NAME_HEIGHT = 35; // text + padding
  // Available height for grid = screen minus header/sort/chips/nav (~280px approx)
  const GRID_AVAILABLE_HEIGHT = Dimensions.get('window').height -150;
  const GRID_ROW_HEIGHT = Math.floor(
    (GRID_AVAILABLE_HEIGHT - GRID_GAP * (GRID_VISIBLE_ROWS - 1)) /
      GRID_VISIBLE_ROWS,
  );
  const GRID_IMAGE_HEIGHT = GRID_ROW_HEIGHT - GRID_NAME_HEIGHT;

  const renderGridItem = useCallback(
    ({item: outfit}: {item: SavedOutfit}) => {
      // Pick best available thumbnail: thumbnailUrl > top image > first allItem image
      const thumbUri =
        outfit.thumbnailUrl ||
        outfit.top?.image ||
        (outfit.allItems && outfit.allItems.length > 0
          ? outfit.allItems[0]?.image
          : undefined);

      return (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setFullScreenOutfit(outfit)}
          style={{
            width: GRID_ITEM_WIDTH,
            height: 335,
            marginBottom: GRID_GAP,
            borderRadius: tokens.borderRadius.switch1,
            overflow: 'hidden',
          }}>
          {thumbUri ? (
            <View style={{
              height: 298,
            }}>
              <FastImage
                source={{
                  uri: thumbUri,
                  priority: FastImage.priority.normal,
                  cache: FastImage.cacheControl.web,
                }}
                style={{
                  width: '100%',
                  height: '100%',
                }}
                resizeMode={FastImage.resizeMode.contain}
              />
            </View>
          ) : (
            <View
              style={{
                width: '100%',
                height: GRID_IMAGE_HEIGHT,
                backgroundColor: theme.colors.surface3,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <MaterialIcons
                name="checkroom"
                size={36}
                color={theme.colors.muted}
              />
            </View>
          )}
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              fontSize: 13,
              fontWeight: '500',
              color: theme.colors.foreground,
              paddingVertical: 6,
            }}>
            {outfit.name?.trim() || 'Unnamed Outfit'}
          </Text>
        </TouchableOpacity>
      );
    },
    [theme, GRID_ITEM_WIDTH, GRID_ROW_HEIGHT, GRID_IMAGE_HEIGHT],
  );

  // Sort/Filter popover submenu transition (matches ClosetScreen pattern)
  const openSubmenu = (view: 'sort' | 'filter') => {
    setMenuView(view);
    submenuOpacity.setValue(0);
    Animated.timing(submenuOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  return (
    <SafeAreaView
      edges={['top']}
      style={[
        globalStyles.screen,
        globalStyles.container,
        {backgroundColor: theme.colors.background, paddingBottom: 0},
      ]}>
        
      {/* Hidden 2x2 grid composite for sharing */}
      {shareOutfit && (
        <View style={{position: 'absolute', left: -9999, top: -9999}}>
          <ViewShot
            ref={shareCompositeRef}
            options={{format: 'png', quality: 0.95}}
            style={{
              width: SHARE_SIZE,
              height: SHARE_SIZE + 80,
              backgroundColor: theme.colors.imageBackground,
            }}>
              
            {/* Full outfit composite image */}
            <Image
              source={{uri: shareOutfit.thumbnailUrl || shareOutfit.top?.image || shareOutfit.allItems?.[0]?.image}}
              style={{width: 400, height: 400, padding: 4, backgroundColor: theme.colors.imageBackground}}
              resizeMode="contain"
            />

            {/* Center watermark with tinted overlay */}
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 80,
                justifyContent: 'center',
                alignItems: 'center',
              }}>
              <View
                style={{
                  backgroundColor: 'rgba(0,0,0,0.5)',
                  paddingHorizontal: 32,
                  paddingVertical: 16,
                  borderRadius: 40,
                  borderWidth: 1.5,
                  borderColor: 'rgba(255,255,255,0.25)',
                  shadowColor: '#000',
                  shadowOffset: {width: 0, height: 4},
                  shadowOpacity: 0.4,
                  shadowRadius: 12,
                }}>
                <Text
                  style={{
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: '500',
                    letterSpacing: 0.5,
                    textAlign: 'center',
                    marginBottom: 4,
                  }}>
                  Created on
                </Text>
                <Text
                  style={{
                    color: '#fff',
                    fontSize: 28,
                    fontWeight: '800',
                    letterSpacing: 1.5,
                    textShadowColor: 'rgba(0,0,0,0.5)',
                    textShadowOffset: {width: 0, height: 2},
                    textShadowRadius: 4,
                  }}>
                  StylHelpr
                </Text>
              </View>
            </View>

            {/* Bottom info section */}
            <View
              style={{
                height: 80,
                backgroundColor: 'rgba(144, 0, 255, 1)',
                paddingHorizontal: 20,
                paddingVertical: 16,
              }}>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: '700',
                  color: '#fff',
                  marginBottom: 8,
                }}
                numberOfLines={1}>
                {shareOutfit.name || 'My Outfit'}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}>
                <View style={{flexDirection: 'row', alignItems: 'center'}}>
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      marginRight: 8,
                      backgroundColor: '#000',
                      overflow: 'hidden',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}>
                    {profilePicture ? (
                      <Image
                        source={{uri: profilePicture}}
                        style={{
                          width: 24,
                          height: 24,
                        }}
                      />
                    ) : (
                      <Text
                        style={{
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: '700',
                        }}>
                        SH
                      </Text>
                    )}
                  </View>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '500',
                      color: '#fff',
                    }}
                    numberOfLines={1}>
                    @{userName.toLowerCase() || 'stylhelpr'}
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '400',
                    color: 'rgba(255,255,255,0.8)',
                  }}>
                  {new Date(shareOutfit.createdAt).toLocaleDateString()}
                </Text>
              </View>
            </View>
          </ViewShot>
        </View>
      )}

      {/* 🧭 Spacer to restore old navbar height */}
      <View
        style={{
          height: Math.max(insets.top - 10, 44), // ✅ min 44px for non-notched devices
          backgroundColor: theme.colors.background
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <Text
          style={[
            globalStyles.header,
            {color: theme.colors.primary, marginBottom: 0},
          ]}>
          Saved Outfits
        </Text>
        <View style={{flexDirection: 'row', gap: 8}}>
          <TouchableOpacity
            onPress={() => {
              hSelect();
              setMenuVisible(prev => !prev);
              setMenuView('main');
            }}
            style={{
              padding: 8,
              borderRadius: 20,
              backgroundColor: menuVisible
                ? theme.colors.foreground
                : theme.colors.surface,
            }}>
            <MaterialIcons
              name="filter-list"
              size={24}
              color={menuVisible ? theme.colors.background : theme.colors.foreground}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              hSelect();
              setViewMode(prev => (prev === 'list' ? 'grid' : 'list'));
            }}
            style={{
              padding: 8,
              borderRadius: 20,
              backgroundColor: theme.colors.surface,
            }}>
            <MaterialIcons
              name={viewMode === 'grid' ? 'view-agenda' : 'grid-view'}
              size={24}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => globalNavigate('OutfitsByOccasion')}
            style={{
              padding: 8,
              borderRadius: 20,
              backgroundColor: theme.colors.surface,
            }}>
            <MaterialIcons
              name="category"
              size={24}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => globalNavigate('OutfitHistory')}
            style={{
              padding: 8,
              marginRight: 16,
              borderRadius: 20,
              backgroundColor: theme.colors.surface,
            }}>
            <MaterialIcons
              name="history"
              size={24}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Active filter/sort indicator chips */}
      {(sortType !== 'newest' || occasionFilter !== null) && (
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 16,
            paddingVertical: 6,
            gap: 8,
            flexWrap: 'wrap',
          }}>
          {sortType !== 'newest' && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme.colors.primary + '20',
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 12,
                gap: 4,
              }}>
              <MaterialIcons name="sort" size={14} color={theme.colors.primary} />
              <Text style={{fontSize: 12, fontWeight: '600', color: theme.colors.primary}}>
                {sortType === 'favorites' ? 'Favorites' : sortType === 'planned' ? 'Planned' : 'Rating'}
              </Text>
              <TouchableOpacity onPress={() => setSortType('newest')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <MaterialIcons name="close" size={14} color={theme.colors.primary} />
              </TouchableOpacity>
            </View>
          )}
          {occasionFilter !== null && OCCASION_CONFIG[occasionFilter] && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: OCCASION_CONFIG[occasionFilter].color + '25',
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 12,
                gap: 4,
              }}>
              <MaterialIcons
                name={OCCASION_CONFIG[occasionFilter].icon as any}
                size={14}
                color={OCCASION_CONFIG[occasionFilter].color}
              />
              <Text style={{fontSize: 12, fontWeight: '600', color: OCCASION_CONFIG[occasionFilter].color}}>
                {OCCASION_CONFIG[occasionFilter].label}
              </Text>
              <TouchableOpacity onPress={() => setOccasionFilter(null)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <MaterialIcons name="close" size={14} color={OCCASION_CONFIG[occasionFilter].color} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Demo indicator banner */}
      {outfitsState === 'demo' && (
        <View
          style={{
            backgroundColor: theme.colors.primary + '20',
            paddingVertical: 10,
            paddingHorizontal: 16,
            marginHorizontal: 16,
            marginBottom: 12,
            borderRadius: 10,
            flexDirection: 'row',
            alignItems: 'center',
          }}>
          <MaterialIcons
            name="info-outline"
            size={20}
            color={theme.colors.primary}
            style={{marginRight: 8}}
          />
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              flex: 1,
            }}>
            This is a sample outfit card. Build your own outfits in "Wardrobe" or have "AI Outfit" create one and save them!
          </Text>
        </View>
      )}

      {/* 🪩 Virtualized FlashList / Grid View */}
      <View style={{flex: 1, width: '100%', marginTop: 12}}>
        {/* Empty state - only show when user had outfits before but now has none */}
        {outfitsState === 'empty-real' && sortedOutfits.length === 0 ? (
          <View
            style={{
              flexDirection: 'row',
              alignSelf: 'center',
              paddingTop: 40,
            }}>
            <Text style={globalStyles.missingDataMessage1}>
              No saved outfits.
            </Text>
            <TooltipBubble
              message="You don't have any saved outfits yet. Tap Wardrobe in the bottom navigation bar to head to the Wardrobe screen, and then tap Build an Outfit. Once you build your first outfit, it will appear back here automatically."
              position="top"
            />
          </View>
        ) : sortedOutfits.length > 0 ? (
          viewMode === 'grid' ? (
            <FlatList
              data={sortedOutfits}
              renderItem={renderGridItem}
              keyExtractor={keyExtractor}
              numColumns={2}
              columnWrapperStyle={{
                justifyContent: 'space-between',
                paddingHorizontal: GRID_PADDING_H,
              }}
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              contentContainerStyle={{
                paddingBottom: 160,
                paddingTop: 4,
              }}
            />
          ) : (
            <FlashList
              ref={flashListRef}
              data={sortedOutfits}
              renderItem={renderOutfitItem}
              keyExtractor={keyExtractor}
              overrideItemLayout={overrideItemLayout}
              drawDistance={ESTIMATED_CARD_HEIGHT * 2}
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              contentContainerStyle={{
                paddingBottom: 160,
                paddingHorizontal: 10,
              }}
            />
          )
        ) : null}
      </View>

      {/* 📝 Edit Outfit Modal */}
      {editingOutfitId && (
        <BlurView
          style={styles.modalContainer}
          blurType="dark"
          blurAmount={20}
          reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
          <Animatable.View
            animation="zoomIn"
            duration={600}
            style={[styles.modalContent, {maxHeight: '80%'}]}>
            <Text
              style={{
                color: theme.colors.foreground,
                fontWeight: '700',
                fontSize: 18,
                marginBottom: 4,
              }}>
              Edit Outfit
            </Text>

            {/* Outfit Name Input */}
            <Text
              style={{
                color: theme.colors.foreground3,
                fontSize: 12,
                fontWeight: '600',
                marginTop: 12,
                marginBottom: 6,
              }}>
              NAME
            </Text>
            <TextInput
              value={editedName}
              onChangeText={setEditedName}
              placeholder="Enter outfit name"
              placeholderTextColor={theme.colors.foreground3}
              style={styles.input}
            />

            {/* Occasion Selector */}
            <Text
              style={{
                color: theme.colors.foreground3,
                fontSize: 12,
                fontWeight: '600',
                marginTop: 16,
                marginBottom: 8,
              }}>
              OCCASION
            </Text>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{marginBottom: 8}}>
              <View style={{flexDirection: 'row', gap: 8, paddingRight: 16}}>
                {/* Clear occasion option */}
                <Pressable
                  onPress={() => setEditedOccasion(undefined)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 16,
                    backgroundColor: !editedOccasion
                      ? '#000'
                      : theme.colors.surface3,
                    borderWidth: 1,
                    borderColor: !editedOccasion
                      ? '#000'
                      : theme.colors.surfaceBorder,
                  }}>
                  <MaterialIcons
                    name="close"
                    size={14}
                    color={!editedOccasion ? '#fff' : theme.colors.foreground3}
                    style={{marginRight: 4}}
                  />
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '600',
                      color: !editedOccasion
                        ? '#fff'
                        : theme.colors.foreground3,
                    }}>
                    None
                  </Text>
                </Pressable>

                {/* Occasion options */}
                {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(key => {
                  const config = OCCASION_CONFIG[key];
                  const isSelected = editedOccasion === key;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => setEditedOccasion(key)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 16,
                        backgroundColor: isSelected
                          ? `${config.color}`
                          : theme.colors.surface3,
                        borderWidth: 1,
                        borderColor: isSelected
                          ? config.color
                          : theme.colors.surfaceBorder,
                      }}>
                      <MaterialIcons
                        name={config.icon as any}
                        size={14}
                        color={theme.colors.foreground3}
                        style={{marginRight: 4}}
                      />
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color: theme.colors.foreground3,
                        }}>
                        {config.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            <View style={[styles.modalActions, {marginTop: 16}]}>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={() => {
                  setEditingOutfitId(null);
                  setEditedName('');
                  setEditedOccasion(undefined);
                }}>
                <Text style={{color: theme.colors.foreground, marginRight: 24}}>
                  Cancel
                </Text>
              </AppleTouchFeedback>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={handleNameSave}>
                <Text style={{color: theme.colors.primary, fontWeight: '700'}}>
                  Save
                </Text>
              </AppleTouchFeedback>
            </View>
          </Animatable.View>
        </BlurView>
      )}

      {/* 📅 Date/Time Picker — Combined Bottom Sheet */}
      {(showDatePicker || showTimePicker) && planningOutfitId && (
        <BlurView
          style={[styles.overlay, {marginTop: 0}]}
          blurType="dark"
          blurAmount={20}
          reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
          <Animatable.View
            ref={datePickerRef}
            animation="fadeInUp"
            duration={1000}
            easing="ease-out-quint"
            style={[styles.sheetContainer]}>
            <View style={styles.grabber} />
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetTitle}>
                {showDatePicker ? 'Pick a date' : 'Pick a time'}
              </Text>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={resetPlanFlow}
                style={styles.sheetPill}>
                <Text style={styles.sheetPillText}>Close</Text>
              </AppleTouchFeedback>
            </View>

            <View
              style={{
                position: 'relative',
                backgroundColor: showDatePicker
                  ? theme.colors.background
                  : theme.colors.background,
                borderRadius: 25,
                paddingBottom: insets.bottom + 10,
                paddingTop: showDatePicker ? 6 : 12,
                alignItems: 'center',
                overflow: 'hidden',
              }}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  opacity: showDatePicker ? 1 : 0,
                  pointerEvents: showDatePicker ? 'auto' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <DateTimePicker
                  value={selectedTempDate || new Date()}
                  mode="date"
                  display="spinner"
                  themeVariant="dark"
                  textColor={theme.colors.foreground}
                  onChange={(e, d) => d && setSelectedTempDate(new Date(d))}
                  style={{marginVertical: -10}}
                />
              </View>
              <View
                style={{
                  opacity: showTimePicker ? 1 : 0,
                  pointerEvents: showTimePicker ? 'auto' : 'none',
                }}>
                <DateTimePicker
                  value={selectedTempTime || new Date()}
                  mode="time"
                  display="spinner"
                  textColor={theme.colors.foreground}
                  onChange={(e, t) => t && setSelectedTempTime(new Date(t))}
                  style={{
                    width: '100%',
                    transform: [{scale: 1.05}],
                    opacity: 1.0,
                  }}
                />
              </View>
            </View>

            <View style={styles.sheetFooterRow}>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={resetPlanFlow}
                style={[
                  styles.sheetPill,
                  {
                    backgroundColor: showDatePicker
                      ? theme.colors.surface
                      : theme.colors.input2,
                  },
                ]}>
                <Text style={styles.sheetPillText}>Cancel</Text>
              </AppleTouchFeedback>
              {showDatePicker ? (
                <AppleTouchFeedback
                  hapticStyle="impactLight"
                  onPress={() => {
                    setShowTimePicker(true);
                    setShowDatePicker(false);
                  }}
                  style={[
                    styles.sheetPill,
                    {backgroundColor: theme.colors.background},
                  ]}>
                  <Text
                    style={{color: theme.colors.foreground, fontWeight: '800'}}>
                    Next: Time
                  </Text>
                </AppleTouchFeedback>
              ) : (
                <AppleTouchFeedback
                  hapticStyle="impactLight"
                  onPress={commitSchedule}
                  style={[
                    styles.sheetPill,
                    {backgroundColor: theme.colors.button1},
                  ]}>
                  <Text
                    style={{
                      color: theme.colors.buttonText1,
                      fontWeight: '800',
                    }}>
                    Done
                  </Text>
                </AppleTouchFeedback>
              )}
            </View>
          </Animatable.View>
        </BlurView>
      )}

      {/* 🧼 Deleted Toast (undo not available since delete is server-side) */}
      {lastDeletedOutfit && (
        <Animatable.View
          animation="bounceInUp"
          duration={800}
          easing="ease-out-back"
          style={styles.toast}>
          <Text style={{color: theme.colors.foreground}}>Outfit deleted</Text>
        </Animatable.View>
      )}

      {/* 🗑 Delete Confirmation */}
      <Modal
        visible={showDeleteConfirm && !!pendingDeleteId}
        transparent
        animationType="fade">
        <BlurView
          style={styles.modalContainer}
          blurType="dark"
          blurAmount={20}
          reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
          <Animatable.View
            animation="zoomIn"
            duration={500}
            style={styles.modalContent}>
            <Text
              style={{
                fontSize: 16,
                color: theme.colors.foreground,
                fontWeight: '700',
                marginBottom: 8,
              }}>
              Delete this outfit?
            </Text>
            <Text
              style={{
                fontSize: 14,
                color: theme.colors.foreground2,
                marginBottom: 18,
              }}>
              This action cannot be undone.
            </Text>
            <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={() => {
                  setShowDeleteConfirm(false);
                  setPendingDeleteId(null);
                }}>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    marginHorizontal: 16,
                  }}>
                  Cancel
                </Text>
              </AppleTouchFeedback>
              <AppleTouchFeedback
                hapticStyle="notificationWarning"
                onPress={() => {
                  if (pendingDeleteId) handleDelete(pendingDeleteId);
                  setShowDeleteConfirm(false);
                  setPendingDeleteId(null);
                }}>
                <Text style={{color: theme.colors.error, fontWeight: '800'}}>
                  Delete
                </Text>
              </AppleTouchFeedback>
            </View>
          </Animatable.View>
        </BlurView>
      </Modal>

      {/* 📤 Share Options Modal */}
      <Modal
        visible={shareOptionsVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setShareOptionsVisible(false)}>
        <Pressable
          style={styles.modalContainer}
          onPress={() => setShareOptionsVisible(false)}>
          <BlurView
            style={StyleSheet.absoluteFill}
            blurType="dark"
            blurAmount={20}
            reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
          />
          <Animatable.View
            animation="slideInUp"
            duration={300}
            style={[
              styles.modalContent,
              {
                width: '90%',
                maxWidth: 340,
                paddingVertical: 20,
              },
            ]}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: '700',
                color: theme.colors.foreground,
                marginBottom: 20,
                textAlign: 'center',
              }}>
              Share Outfit
            </Text>

            {/* Share to Community */}
            <AppleTouchFeedback
              hapticStyle="impactMedium"
              onPress={handleShareToCommunity}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme.colors.button1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 14,
                marginBottom: 12,
              }}>
              <MaterialIcons
                name="groups"
                size={24}
                color={theme.colors.buttonText1}
              />
              <Text
                style={{
                  color: theme.colors.buttonText1,
                  fontSize: 16,
                  fontWeight: '600',
                  marginLeft: 12,
                }}>
                Share to Community
              </Text>
            </AppleTouchFeedback>

            {/* Share Externally */}
            <AppleTouchFeedback
              hapticStyle="impactLight"
              onPress={handleShareExternal}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme.colors.surface2,
                paddingVertical: 14,
                paddingHorizontal: 20,
                marginBottom: 12,
                borderRadius: 14,
                borderWidth: tokens.borderWidth.md,
                borderColor: theme.colors.muted,
              }}>
              <MaterialIcons
                name="ios-share"
                size={24}
                color={theme.colors.foreground}
              />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 16,
                  fontWeight: '600',
                  marginLeft: 12,
                }}>
                Share via...
              </Text>
            </AppleTouchFeedback>

            {/* Cancel */}
            <AppleTouchFeedback
              hapticStyle="selection"
              onPress={() => {
                setShareOptionsVisible(false);
                setPendingShareOutfit(null);
              }}
              style={{
                paddingVertical: 12,
                alignItems: 'center',
                borderRadius: 14,
                borderWidth: tokens.borderWidth.md,
                borderColor: theme.colors.muted,
              }}>
              <Text
                style={{
                  color: theme.colors.muted,
                  fontSize: 16,
                }}>
                Cancel
              </Text>
            </AppleTouchFeedback>
          </Animatable.View>
        </Pressable>
      </Modal>

      {/* 🌐 Community Share Modal */}
      <Modal
        visible={communityShareModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCommunityShareModalVisible(false)}>
        <Pressable
          style={styles.modalContainer}
          onPress={() => setCommunityShareModalVisible(false)}>
          <BlurView
            style={StyleSheet.absoluteFill}
            blurType="dark"
            blurAmount={20}
            reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
          />
          <Pressable
            onPress={e => e.stopPropagation()}
            style={[
              styles.modalContent,
              {
                width: '90%',
                maxWidth: 360,
                paddingVertical: 24,
              },
            ]}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: '700',
                color: theme.colors.foreground,
                marginBottom: 20,
                textAlign: 'center',
              }}>
              Share to Community
            </Text>

            {/* Description Input */}
            <Text
              style={{
                fontSize: 14,
                color: theme.colors.foreground2,
                marginBottom: 8,
              }}>
              Description
            </Text>
            <TextInput
              value={communityDescription}
              onChangeText={setCommunityDescription}
              placeholder={
                pendingShareOutfit?.name || 'Describe your outfit...'
              }
              placeholderTextColor={theme.colors.muted}
              multiline
              style={{
                backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                borderRadius: 12,
                padding: 14,
                color: theme.colors.foreground,
                fontSize: 15,
                minHeight: 80,
                marginBottom: 16,
                textAlignVertical: 'top',
              }}
            />

            {/* Tags Input */}
            <Text
              style={{
                fontSize: 14,
                color: theme.colors.foreground2,
                marginBottom: 8,
              }}>
              Tags (comma-separated)
            </Text>
            <TextInput
              value={communityTags}
              onChangeText={setCommunityTags}
              placeholder="casual, summer, streetwear..."
              placeholderTextColor={theme.colors.muted}
              style={{
                backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
                borderRadius: 12,
                padding: 14,
                color: theme.colors.foreground,
                fontSize: 15,
                marginBottom: 24,
              }}
            />

            {/* Action Buttons */}
            <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
              <AppleTouchFeedback
                hapticStyle="selection"
                onPress={() => {
                  setCommunityShareModalVisible(false);
                  setPendingShareOutfit(null);
                }}
                style={{paddingHorizontal: 20, paddingVertical: 12}}>
                <Text style={{color: theme.colors.muted, fontSize: 16}}>
                  Cancel
                </Text>
              </AppleTouchFeedback>

              <AppleTouchFeedback
                hapticStyle="impactMedium"
                onPress={handleConfirmCommunityShare}
                style={{
                  backgroundColor: theme.colors.button1,
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 12,
                  marginLeft: 12,
                }}>
                <Text
                  style={{
                    color: theme.colors.buttonText1,
                    fontSize: 16,
                    fontWeight: '600',
                  }}>
                  {createPostMutation.isPending ? 'Sharing...' : 'Share'}
                </Text>
              </AppleTouchFeedback>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 🖼 Full-Screen Outfit Modal — matches AI Stylist detail view */}
      <Modal
        visible={!!fullScreenOutfit}
        transparent
        animationType="fade"
        onRequestClose={() => setFullScreenOutfit(null)}>
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.background,
          }}>
          {/* Close button */}
          <TouchableOpacity
            onPress={() => setFullScreenOutfit(null)}
            style={{
              position: 'absolute',
              top: 60,
              right: 20,
              zIndex: 10,
              padding: 6,
              backgroundColor: 'white',
              borderRadius: 50,
              borderColor: 'black',
              borderWidth: theme.borderWidth.hairline
            }}>
            <MaterialIcons name="close" size={22} color="black" />
          </TouchableOpacity>

          <ScrollView
            contentContainerStyle={{
              alignItems: 'center',
              paddingTop: 100,
              paddingBottom: 40,
            }}
            showsVerticalScrollIndicator={false}>
          {(() => {
            if (!fullScreenOutfit) return null;
            const topItem = fullScreenOutfit.top;
            const bottomItem = fullScreenOutfit.bottom;
            const shoesItem = fullScreenOutfit.shoes;
            const knownIds = new Set(
              [topItem?.id, bottomItem?.id, shoesItem?.id].filter(Boolean),
            );
            const extraItems = (fullScreenOutfit.allItems || []).filter(
              i => !knownIds.has(i.id),
            );
            const allItems =
              fullScreenOutfit.allItems ||
              [topItem, bottomItem, shoesItem].filter(Boolean);
            const screenWidth = Dimensions.get('window').width;

            return (
              <View style={{alignItems: 'center', width: '100%'}}>
                {/* Outfit Title */}
                <Text style={{color: theme.colors.foreground, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 16, paddingHorizontal: 32}} numberOfLines={1}>
                  {fullScreenOutfit.name || 'Outfit'}
                </Text>

                {/* Outfit Card — snapshot or composite fallback */}
                <View
                  style={{
                    width: screenWidth - 16,
                    borderRadius: tokens.borderRadius.switch1,
                    backgroundColor: theme.colors.imageBackground,
                    overflow: 'hidden',
                    justifyContent: 'center',
                    alignItems: 'center'
                  }}>
                  {fullScreenOutfit.thumbnailUrl ? (
                    <Image
                      source={{uri: fullScreenOutfit.thumbnailUrl}}
                      style={{width: '100%', height: 510, aspectRatio: 1}}
                      resizeMode="contain"
                    />
                  ) : (
                    <View
                      style={{
                        flexDirection: 'row',
                        paddingVertical: 12,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                      {/* Left column: first extra item (outerwear) */}
                      <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8}}>
                        {extraItems.length > 0 && extraItems[0]?.image && (
                          <Image
                            source={{uri: extraItems[0].image}}
                            style={{width: 80, height: 130}}
                            resizeMode="contain"
                          />
                        )}
                      </View>

                      {/* Center column: Top → Bottom → Shoes (overlapping) */}
                      <View style={{flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 6}}>
                        {topItem?.image && (
                          <Image
                            source={{uri: topItem.image}}
                            style={{width: 200, height: 190, zIndex: 3}}
                            resizeMode="contain"
                          />
                        )}
                        {bottomItem?.image && (
                          <Image
                            source={{uri: bottomItem.image}}
                            style={{width: 200, height: 220, marginTop: -42, zIndex: 2}}
                            resizeMode="contain"
                          />
                        )}
                        {shoesItem?.image && (
                          <Image
                            source={{uri: shoesItem.image}}
                            style={{width: 160, height: 145, marginTop: -32, zIndex: 1}}
                            resizeMode="contain"
                          />
                        )}
                      </View>

                      {/* Right column: remaining extras (accessories) */}
                      <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8, gap: 10}}>
                        {extraItems.slice(1).map((acc, idx) =>
                          acc?.image ? (
                            <Image
                              key={acc.id || idx}
                              source={{uri: acc.image}}
                              style={{width: 80, height: 80}}
                              resizeMode="contain"
                            />
                          ) : null,
                        )}
                      </View>
                    </View>
                  )}
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
                    {allItems.map((item, idx) => (
                      <View
                        key={item.id || idx}
                        style={{
                          width: (screenWidth - 52) / 2,
                          height: (screenWidth - 0) / 2,
                          borderRadius: tokens.borderRadius.switch1,
                          overflow: 'hidden',
                        }}>
                        <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.imageBackground,}}>
                          <Image
                            source={{uri: item.image}}
                            style={{width: 150, height: 150}}
                            resizeMode="contain"
                          />
                        </View>
                        <View style={{paddingVertical: 8}}>
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

                {/* Notes */}
                {fullScreenOutfit.notes?.trim() && (
                  <Text
                    style={{
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: '400',
                      textAlign: 'center',
                      marginTop: 20,
                      paddingHorizontal: 24,
                      opacity: 0.85,
                      lineHeight: 20,
                    }}>
                    {fullScreenOutfit.notes.trim()}
                  </Text>
                )}

                {/* Tags */}
                {fullScreenOutfit.tags?.length ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      justifyContent: 'center',
                      marginTop: 24,
                    }}>
                    {fullScreenOutfit.tags.map(tag => (
                      <View
                        key={tag}
                        style={{
                          backgroundColor: 'rgba(255,255,255,0.1)',
                          borderRadius: 20,
                          paddingHorizontal: 14,
                          paddingVertical: 6,
                          margin: 6,
                        }}>
                        <Text
                          style={{
                            color: '#fff',
                            fontSize: 14,
                            fontWeight: '600',
                            letterSpacing: 0.2,
                          }}>
                          #{tag}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}

              </View>
            );
          })()}
          </ScrollView>
        </View>
      </Modal>

      {/* Scroll-to-top button */}
      <AppleTouchFeedback
        onPress={() => {
          flashListRef.current?.scrollToOffset({offset: 0, animated: true});
        }}
        style={{
          position: 'absolute',
          bottom: 100,
          right: 20,
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: 'rgba(0,0,0,0.6)',
          borderColor: theme.colors.muted,
          borderWidth: tokens.borderWidth.md,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 8,
          shadowOffset: {width: 0, height: 4},
        }}>
        <MaterialIcons name="keyboard-arrow-up" size={32} color="#fff" />
      </AppleTouchFeedback>

      {/* Sort / Filter Popover (matches ClosetScreen pattern) */}
      {menuVisible && (
        <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
          <View
            style={{
              position: 'absolute',
              top: 20,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'transparent',
              zIndex: 9999,
            }}>
            <TouchableWithoutFeedback>
              <View>
                {menuView === 'main' && (
                  <View
                    style={{
                      position: 'absolute',
                      top: insets.top + 85,
                      right: 20,
                      width: 220,
                      backgroundColor: theme.colors.surface,
                      borderRadius: 16,
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      elevation: 20,
                      shadowColor: '#000',
                      shadowOpacity: 0.25,
                      shadowOffset: {width: 0, height: 4},
                      shadowRadius: 14,
                      zIndex: 9999,
                    }}>
                         <TouchableOpacity
                      style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}
                      onPress={() => {
                        hSelect();
                        openSubmenu('filter');
                      }}>
                      <MaterialIcons name="filter-list" size={22} color={theme.colors.foreground} />
                      <Text style={{fontSize: 17, color: theme.colors.foreground, fontWeight: '600', marginLeft: 10}}>
                        Filter by Occasion
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}
                      onPress={() => {
                        hSelect();
                        openSubmenu('sort');
                      }}>
                      <MaterialIcons name="sort" size={22} color={theme.colors.foreground} />
                      <Text style={{fontSize: 17, color: theme.colors.foreground, fontWeight: '600', marginLeft: 10}}>
                        Sort
                      </Text>
                    </TouchableOpacity>
                 
                  </View>
                )}

                {menuView === 'sort' && (
                  <Animated.View
                    style={{
                      position: 'absolute',
                      top: insets.top + 85,
                      right: 16,
                      width: 260,
                      backgroundColor: theme.colors.surface,
                      borderRadius: 16,
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      elevation: 20,
                      shadowColor: '#000',
                      shadowOpacity: 0.25,
                      shadowOffset: {width: 0, height: 4},
                      shadowRadius: 14,
                      zIndex: 9999,
                      opacity: submenuOpacity,
                      transform: [{scale: submenuOpacity.interpolate({inputRange: [0, 1], outputRange: [0.95, 1]})}],
                    }}>
                    {(
                      [
                        {key: 'newest', label: 'Newest', icon: 'schedule'},
                        {key: 'favorites', label: 'Favorites', icon: 'favorite'},
                        {key: 'planned', label: 'Planned', icon: 'event'},
                        {key: 'stars', label: 'Rating', icon: 'star'},
                      ] as const
                    ).map(({key, label, icon}) => (
                      <TouchableOpacity
                        key={key}
                        onPress={() => {
                          hSelect();
                          setSortType(key);
                          setMenuVisible(false);
                        }}
                        style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
                        <MaterialIcons
                          name={icon}
                          size={20}
                          color={sortType === key ? theme.colors.primary : theme.colors.foreground}
                        />
                        <Text
                          style={{
                            fontSize: 16,
                            color: sortType === key ? theme.colors.primary : theme.colors.foreground,
                            fontWeight: sortType === key ? '700' : '400',
                            marginLeft: 10,
                            flex: 1,
                          }}>
                          {label}
                        </Text>
                        {sortType === key && (
                          <MaterialIcons name="check" size={18} color={theme.colors.primary} />
                        )}
                      </TouchableOpacity>
                    ))}
                  </Animated.View>
                )}

                {menuView === 'filter' && (
                  <Animated.View
                    style={{
                      position: 'absolute',
                      top: insets.top + 85,
                      right: 16,
                      width: 280,
                      maxHeight: Dimensions.get('window').height * 0.6,
                      backgroundColor: theme.colors.surface,
                      borderRadius: 16,
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      elevation: 20,
                      shadowColor: '#000',
                      shadowOpacity: 0.25,
                      shadowOffset: {width: 0, height: 4},
                      shadowRadius: 14,
                      zIndex: 9999,
                      opacity: submenuOpacity,
                      transform: [{scale: submenuOpacity.interpolate({inputRange: [0, 1], outputRange: [0.95, 1]})}],
                    }}>
                    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom: 8}}>
                      {/* "All" option */}
                      <TouchableOpacity
                        onPress={() => {
                          hSelect();
                          setOccasionFilter(null);
                          setMenuVisible(false);
                        }}
                        style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
                        <MaterialIcons
                          name="select-all"
                          size={20}
                          color={occasionFilter === null ? theme.colors.primary : theme.colors.foreground}
                        />
                        <Text
                          style={{
                            fontSize: 16,
                            color: occasionFilter === null ? theme.colors.primary : theme.colors.foreground,
                            fontWeight: occasionFilter === null ? '700' : '400',
                            marginLeft: 10,
                            flex: 1,
                          }}>
                          All ({displayOutfits.length})
                        </Text>
                        {occasionFilter === null && (
                          <MaterialIcons name="check" size={18} color={theme.colors.primary} />
                        )}
                      </TouchableOpacity>

                      {/* Occasion options */}
                      {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(occasion => {
                        const config = OCCASION_CONFIG[occasion];
                        const count = displayOutfits.filter(o => o.occasion === occasion).length;
                        if (count === 0) return null;
                        const isSelected = occasionFilter === occasion;

                        return (
                          <TouchableOpacity
                            key={occasion}
                            onPress={() => {
                              hSelect();
                              setOccasionFilter(isSelected ? null : occasion);
                              setMenuVisible(false);
                            }}
                            style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
                            <MaterialIcons
                              name={config.icon as any}
                              size={20}
                              color={isSelected ? config.color : theme.colors.foreground}
                            />
                            <Text
                              style={{
                                fontSize: 16,
                                color: isSelected ? config.color : theme.colors.foreground,
                                fontWeight: isSelected ? '700' : '400',
                                marginLeft: 10,
                                flex: 1,
                              }}>
                              {config.label} ({count})
                            </Text>
                            {isSelected && (
                              <MaterialIcons name="check" size={18} color={config.color} />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </Animated.View>
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      )}
    </SafeAreaView>
  );
}


////////////////////

// import React, {useEffect, useRef, useState, useCallback, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   TouchableOpacity,
//   Alert,
//   TextInput,
//   Modal,
//   Dimensions,
//   Platform,
//   Animated,
//   Easing,
//   ScrollView,
//   PanResponder,
//   Pressable,
//   FlatList,
//   TouchableWithoutFeedback,
// } from 'react-native';
// import {FlashList} from '@shopify/flash-list';
// import FastImage from 'react-native-fast-image';
// import {BlurView} from '@react-native-community/blur';
// import * as Animatable from 'react-native-animatable';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import DateTimePicker from '@react-native-community/datetimepicker';
// import ViewShot from 'react-native-view-shot';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import PushNotification from 'react-native-push-notification';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// import {useAppTheme} from '../context/ThemeContext';
// import {useFavorites} from '../hooks/useFavorites';
// import {useUUID} from '../context/UUIDContext';
// import {
//   useOutfitsQuery,
//   useUpdateOutfit,
//   useDeleteOutfit,
//   useScheduleOutfit,
//   useCancelScheduledOutfit,
//   useMarkOutfitWorn,
//   useUnmarkOutfitWorn,
//   useInvalidateSavedOutfits,
//   SavedOutfitData,
// } from '../hooks/useOutfitsData';
// import {useUserProfile} from '../hooks/useHomeData';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {addOutfitToCalendar, removeCalendarEvent} from '../utils/calendar';
// import {addToInbox} from '../utils/notificationInbox';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import SwipeableCard from '../components/SwipeableCard/SwipeableCard';
// import {Share} from 'react-native';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {useCreatePost} from '../hooks/useCommunityApi';
// import {globalNavigate} from '../MainApp';

// const {width: SCREEN_WIDTH} = Dimensions.get('window');
// const CARD_WIDTH = SCREEN_WIDTH - 32;
// const ESTIMATED_CARD_HEIGHT = 320;

// // Animated pressable with scale effect for images
// const ScalePressable = ({
//   children,
//   onPress,
//   style,
// }: {
//   children: React.ReactNode;
//   onPress: () => void;
//   style?: any;
// }) => {
//   const scaleAnim = useRef(new Animated.Value(1)).current;

//   const handlePressIn = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 0.97,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   const handlePressOut = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 1,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   return (
//     <Pressable
//       onPress={onPress}
//       onPressIn={handlePressIn}
//       onPressOut={handlePressOut}>
//       <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
//         {children}
//       </Animated.View>
//     </Pressable>
//   );
// };

// // Occasion types with color coding
// type OutfitOccasion =
//   | 'Work'
//   | 'DateNight'
//   | 'Casual'
//   | 'Formal'
//   | 'Travel'
//   | 'Gym'
//   | 'Weekend'
//   | 'Party'
//   | 'Interview'
//   | 'Brunch';

// // Occasion → Color & Icon mapping
// const OCCASION_CONFIG: Record<
//   OutfitOccasion,
//   {color: string; icon: string; label: string}
// > = {
//   Work: {color: '#3B82F6', icon: 'work', label: 'Work'},
//   DateNight: {color: '#EC4899', icon: 'favorite', label: 'Date Night'},
//   Casual: {color: '#22C55E', icon: 'weekend', label: 'Casual'},
//   Formal: {color: '#F59E0B', icon: 'star', label: 'Formal'},
//   Travel: {color: '#14B8A6', icon: 'flight', label: 'Travel'},
//   Gym: {color: '#F97316', icon: 'fitness-center', label: 'Gym'},
//   Weekend: {color: '#8B5CF6', icon: 'wb-sunny', label: 'Weekend'},
//   Party: {color: '#EF4444', icon: 'celebration', label: 'Party'},
//   Interview: {color: '#6366F1', icon: 'business-center', label: 'Interview'},
//   Brunch: {color: '#F472B6', icon: 'brunch-dining', label: 'Brunch'},
// };

// // Use SavedOutfitData from useOutfitsData hook
// type SavedOutfit = SavedOutfitData;

// const CLOSET_KEY = 'savedOutfits';
// const FAVORITES_KEY = 'favoriteOutfits';
// const SHEET_MAX_H = Math.min(Dimensions.get('window').height * 0.2, 560);

// export default function SavedOutfitsScreen() {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const insets = useSafeAreaInsets();
//   const [profilePicture, setProfilePicture] = useState<string>('');

//   // TanStack Query: Fetch user profile for name
//   const {data: userProfile} = useUserProfile(userId || '');
//   const userName =
//     `${userProfile?.first_name || ''}${userProfile?.last_name || ''}`.trim() ||
//     'StylHelpr';

//   // Load profile picture from AsyncStorage
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(`profile_picture:${userId}`);
//       if (cached) {
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   if (!userId) return null;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },

//     // 🪩 Core Outfit Card
//     card: {
//       backgroundColor: 'red',
//       borderRadius: 24,
//       padding: 18,
//       marginBottom: 6,
//       borderWidth: tokens.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowRadius: 22,
//       shadowOffset: {width: 0, height: 10},
//       transform: [{scale: 0.98}],
//       elevation: 12,
//     },

//     timestamp: {
//       fontSize: 12,
//       color: theme.colors.foreground3,
//       marginTop: 4,
//       marginBottom: 4,
//       fontWeight: '500',
//       letterSpacing: 0.2,
//     },

//     actions: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },

//     imageRow: {
//       flexDirection: 'row',
//       justifyContent: 'flex-start',
//       // marginTop: 12,
//       gap: 12,
//     },

//     notes: {
//       marginTop: 12,
//       fontStyle: 'italic',
//       color: theme.colors.foreground3,
//       fontSize: 14,
//       lineHeight: 20,
//     },

//     stars: {
//       flexDirection: 'row',
//       marginTop: 6,
//     },

//     // 🌫️ Overlay for blur modals / pickers
//     overlay: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'center',
//       alignItems: 'center',
//       backgroundColor: 'rgba(0,0,0,0.3)',
//     },

//     // 📦 Centered modal container
//     modalContainer: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },

//     // ✏️ Edit Name / Delete Confirmation Modal
//     modalContent: {
//       backgroundColor: theme.colors.surface,
//       padding: 22,
//       borderRadius: 20,
//       width: '100%',
//       maxWidth: 400,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 28,
//       shadowOffset: {width: 0, height: 14},
//       elevation: 20,
//       transform: [{scale: 1}],
//     },

//     input: {
//       marginTop: 12,
//       borderBottomWidth: 1,
//       borderBottomColor: theme.colors.muted,
//       paddingVertical: 8,
//       color: theme.colors.foreground,
//       fontSize: 16,
//     },

//     modalActions: {
//       flexDirection: 'row',
//       justifyContent: 'flex-end',
//       marginTop: 20,
//       gap: 20,
//     },

//     // 🪟 Full-screen Outfit Viewer
//     fullModalContainer: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'flex-start',
//       alignItems: 'center',
//       paddingTop: 72,
//       paddingHorizontal: 124,
//     },

//     fullImage: {
//       width: '70%',
//       aspectRatio: 1,
//       marginVertical: 16,
//       borderRadius: 18,
//       backgroundColor: theme.colors.background,
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 24,
//       shadowOffset: {width: 0, height: 16},
//       elevation: 18,
//     },

//     // 📅 Bottom Sheet
//     sheetContainer: {
//       width: '90%',
//       backgroundColor: theme.colors.surface3,
//       borderRadius: 30,
//       paddingTop: 12,
//       paddingBottom: Platform.OS === 'ios' ? 16 : 16,
//       paddingHorizontal: 20,
//       // maxHeight: SHEET_MAX_H,
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 32,
//       shadowOffset: {width: 0, height: -14},
//       elevation: 26,
//     },

//     grabber: {
//       alignSelf: 'center',
//       width: 50,
//       height: 6,
//       borderRadius: 3,
//       backgroundColor: 'rgba(255,255,255,0.25)',
//       marginBottom: 12,
//     },

//     sheetHeaderRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'space-between',
//       marginBottom: 12,
//       paddingHorizontal: 4,
//     },

//     sheetTitle: {
//       fontSize: 18,
//       fontWeight: '800',
//       color: theme.colors.foreground,
//       letterSpacing: 0.3,
//     },

//     sheetPill: {
//       paddingHorizontal: 16,
//       paddingVertical: 10,
//       borderRadius: 22,
//       backgroundColor: theme.colors.input2 ?? 'rgba(43,43,43,1)',
//     },

//     sheetPillText: {
//       color: theme.colors.foreground3 ?? '#EAEAEA',
//       fontWeight: '700',
//       letterSpacing: 0.2,
//     },

//     sheetFooterRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       paddingHorizontal: 6,
//       marginTop: 14,
//       marginBottom: 10,
//     },

//     // 🍞 Toast
//     toast: {
//       position: 'absolute',
//       bottom: 30,
//       left: 20,
//       right: 20,
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 14,
//       paddingHorizontal: 18,
//       borderRadius: 16,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 20,
//       shadowOffset: {width: 0, height: 10},
//       elevation: 20,
//     },
//   });

//   // 🧠 State Management
//   const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

//   // Load persisted view mode
//   useEffect(() => {
//     AsyncStorage.getItem('saved_outfits_view_mode').then(val => {
//       if (val === 'list' || val === 'grid') {
//         setViewMode(val);
//       }
//     });
//   }, []);

//   // Persist view mode on change
//   useEffect(() => {
//     AsyncStorage.setItem('saved_outfits_view_mode', viewMode);
//   }, [viewMode]);

//   const [menuVisible, setMenuVisible] = useState(false);
//   const [menuView, setMenuView] = useState<'main' | 'sort' | 'filter'>('main');
//   const submenuOpacity = useRef(new Animated.Value(0)).current;
//   const [editingOutfitId, setEditingOutfitId] = useState<string | null>(null);
//   const [editedName, setEditedName] = useState('');
//   const [editedOccasion, setEditedOccasion] = useState<
//     OutfitOccasion | undefined
//   >(undefined);

//   // Demo outfit state - tracks if user has ever had real saved outfits
//   const [hasEverHadOutfits, setHasEverHadOutfits] = useState<boolean | null>(
//     null,
//   );

//   // Demo outfit items (using bundled wardrobe assets)
//   const demoOutfits: SavedOutfit[] = [
//     {
//       id: 'demo-outfit-1',
//       name: 'Upscale Style 1',
//       type: 'custom',
//       top: {
//         id: 'demo-top',
//         name: 'Cable Knit Sweater',
//         image: Image.resolveAssetSource(
//           require('../assets/images/top-sweater1.png'),
//         ).uri,
//       },
//       bottom: {
//         id: 'demo-bottom',
//         name: 'Classic Blue Jeans',
//         image: Image.resolveAssetSource(
//           require('../assets/images/bottoms-jeans1.png'),
//         ).uri,
//       },
//       shoes: {
//         id: 'demo-shoes',
//         name: 'Black Leather Loafers',
//         image: Image.resolveAssetSource(
//           require('../assets/images/shoes-loafers1.jpg'),
//         ).uri,
//       },
//       createdAt: new Date().toISOString(),
//       occasion: 'DateNight',
//       favorited: true,
//       tags: [],
//     },
//   ];

//   // Load hasEverHadOutfits flag from AsyncStorage
//   useEffect(() => {
//     const loadDemoFlag = async () => {
//       try {
//         const hasOutfits = await AsyncStorage.getItem('saved_outfits_has_real');
//         setHasEverHadOutfits(hasOutfits === 'true');
//       } catch (err) {
//         console.error('Failed to load saved outfits demo flag:', err);
//         setHasEverHadOutfits(false);
//       }
//     };
//     loadDemoFlag();
//   }, []);

//   // Occasion filter state (null = "All")
//   const [occasionFilter, setOccasionFilter] = useState<OutfitOccasion | null>(
//     null,
//   );

//   const [planningOutfitId, setPlanningOutfitId] = useState<string | null>(null);
//   const [showDatePicker, setShowDatePicker] = useState(false);
//   const [showTimePicker, setShowTimePicker] = useState(false);
//   const [selectedTempDate, setSelectedTempDate] = useState<Date | null>(null);
//   const [selectedTempTime, setSelectedTempTime] = useState<Date | null>(null);
//   const [lastDeletedOutfit, setLastDeletedOutfit] =
//     useState<SavedOutfit | null>(null);

//   const {
//     favorites,
//     isLoading: favoritesLoading,
//     toggleFavorite,
//   } = useFavorites(userId);

//   // TanStack Query: Fetch outfits with caching
//   const {
//     data: combinedOutfits = [],
//     isLoading: outfitsLoading,
//     refetch: refetchOutfits,
//   } = useOutfitsQuery(userId, favorites);

//   // Update hasEverHadOutfits when real content appears
//   useEffect(() => {
//     if (
//       combinedOutfits &&
//       combinedOutfits.length > 0 &&
//       hasEverHadOutfits === false
//     ) {
//       setHasEverHadOutfits(true);
//       AsyncStorage.setItem('saved_outfits_has_real', 'true');
//     }
//   }, [combinedOutfits, hasEverHadOutfits]);

//   // Compute outfits state: 'demo' | 'real' | 'empty-real'
//   const outfitsState =
//     combinedOutfits && combinedOutfits.length > 0
//       ? 'real'
//       : hasEverHadOutfits
//         ? 'empty-real'
//         : 'demo';

//   // Use demo outfits when in demo state, otherwise use real outfits
//   const displayOutfits =
//     outfitsState === 'demo' ? demoOutfits : combinedOutfits;

//   console.log('🎨 SavedOutfits render:', {
//     outfitsState,
//     combinedOutfitsCount: combinedOutfits?.length,
//     displayOutfitsCount: displayOutfits?.length,
//     hasEverHadOutfits,
//   });

//   // TanStack Query: Mutations
//   const updateOutfitMutation = useUpdateOutfit();
//   const deleteOutfitMutation = useDeleteOutfit();
//   const scheduleOutfitMutation = useScheduleOutfit();
//   const cancelScheduledOutfitMutation = useCancelScheduledOutfit();
//   const markWornMutation = useMarkOutfitWorn();
//   const unmarkWornMutation = useUnmarkOutfitWorn();
//   const invalidateSavedOutfits = useInvalidateSavedOutfits();

//   const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
//   const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

//   const datePickerRef = useRef<Animatable.View & View>(null);

//   const viewRefs = useRef<{[key: string]: ViewShot | null}>({});
//   const [fullScreenOutfit, setFullScreenOutfit] = useState<SavedOutfit | null>(
//     null,
//   );
//   const displayedOutfitRef = useRef<SavedOutfit | null>(null);

//   // FlashList ref for scroll-to-top
//   const flashListRef = useRef<any>(null);

//   const screenH = Dimensions.get('window').height;
//   const translateY = useRef(new Animated.Value(screenH)).current;

//   useEffect(() => {
//     if (fullScreenOutfit) {
//       // 🟢 Animate up from offscreen only when opening
//       Animated.timing(translateY, {
//         toValue: 0,
//         duration: 300,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }).start();
//     }
//   }, [fullScreenOutfit]);

//   const handleClose = useCallback(() => {
//     // 🧠 just trigger the modal to close
//     setFullScreenOutfit(null);
//   }, []);

//   const panResponder = useRef(
//     PanResponder.create({
//       onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 8,
//       onPanResponderMove: (_e, g) => {
//         if (g.dy > 0) translateY.setValue(g.dy);
//       },
//       onPanResponderRelease: (_e, g) => {
//         if (g.dy > 100 || g.vy > 0.3) {
//           handleClose();
//         } else {
//           Animated.spring(translateY, {
//             toValue: 0,
//             useNativeDriver: true,
//           }).start();
//         }
//       },
//     }),
//   ).current;

//   const hSelect = () =>
//     ReactNativeHapticFeedback.trigger('selection', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   // ⏱️ Utility: Combine date + time
//   const combineDateAndTime = (date: Date, time: Date) => {
//     const d = new Date(date);
//     const t = new Date(time);
//     d.setHours(t.getHours(), t.getMinutes(), 0, 0);
//     return d;
//   };

//   // Ref for the share composite ViewShot
//   const shareCompositeRef = useRef<ViewShot>(null);
//   const [shareOutfit, setShareOutfit] = useState<SavedOutfit | null>(null);
//   const [shareOptionsVisible, setShareOptionsVisible] = useState(false);
//   const [pendingShareOutfit, setPendingShareOutfit] =
//     useState<SavedOutfit | null>(null);
//   const [communityShareModalVisible, setCommunityShareModalVisible] =
//     useState(false);
//   const [communityDescription, setCommunityDescription] = useState('');
//   const [communityTags, setCommunityTags] = useState('');

//   // Community post mutation
//   const createPostMutation = useCreatePost();

//   // Show share options when user taps share button
//   const handleSharePress = (outfit: SavedOutfit) => {
//     ReactNativeHapticFeedback.trigger('impactLight', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });
//     setPendingShareOutfit(outfit);
//     setShareOptionsVisible(true);
//   };

//   // Share to Community
//   const handleShareToCommunity = async () => {
//     if (!pendingShareOutfit || !userId) return;

//     setShareOptionsVisible(false);
//     setCommunityDescription('');
//     setCommunityTags('');
//     setCommunityShareModalVisible(true);
//   };

//   const handleConfirmCommunityShare = async () => {
//     if (!pendingShareOutfit || !userId) return;

//     try {
//       ReactNativeHapticFeedback.trigger('impactMedium', {
//         enableVibrateFallback: true,
//         ignoreAndroidSystemSettings: false,
//       });

//       const tagsArray = communityTags
//         .split(',')
//         .map(t => t.trim().toLowerCase())
//         .filter(t => t.length > 0);

//       const outfitName =
//         communityDescription || pendingShareOutfit.name || 'My outfit';
//       // Note: userId is extracted from JWT token on backend, not sent in body
//       await createPostMutation.mutateAsync({
//         topImage: pendingShareOutfit.top?.image,
//         bottomImage: pendingShareOutfit.bottom?.image,
//         shoesImage: pendingShareOutfit.shoes?.image,
//         name: outfitName,
//         description: '',
//         tags: tagsArray.length > 0 ? tagsArray : ['outfit'],
//       });

//       setCommunityShareModalVisible(false);
//       setPendingShareOutfit(null);
//       Alert.alert('Success', 'Your outfit has been shared to the community!');
//     } catch (error) {
//       console.error('Failed to share to community:', error);
//       Alert.alert('Error', 'Failed to share to community. Please try again.');
//     }
//   };

//   // Share externally via native share sheet
//   const handleShareExternal = async () => {
//     setShareOptionsVisible(false);
//     if (pendingShareOutfit) {
//       await handleShareOutfit(pendingShareOutfit);
//       setPendingShareOutfit(null);
//     }
//   };

//   const handleShareOutfit = async (outfit: SavedOutfit) => {
//     try {
//       // ✅ subtle tap
//       ReactNativeHapticFeedback.trigger('impactLight', {
//         enableVibrateFallback: true,
//         ignoreAndroidSystemSettings: false,
//       });

//       // Preload profile picture if available
//       if (profilePicture) {
//         await Image.prefetch(profilePicture);
//       }

//       // Set the outfit to render the composite
//       setShareOutfit(outfit);

//       // Wait for the composite to render
//       await new Promise(resolve => setTimeout(resolve, 300));

//       // Capture the 2x2 grid composite
//       if (!shareCompositeRef.current) {
//         throw new Error('Share composite ref not ready');
//       }

//       const compositeUri = await shareCompositeRef.current.capture?.();

//       // 📨 open native iOS share sheet
//       await Share.share({
//         url: compositeUri,
//         message: `Check out my outfit "${outfit.name || ''}" via StylHelpr`,
//         title: 'Share Your Look',
//       });

//       // Clear the share outfit
//       setShareOutfit(null);
//     } catch (err) {
//       console.error('Error sharing look:', err);
//       setShareOutfit(null);
//     }
//   };

//   const handleNameSave = async () => {
//     if (!editingOutfitId) return;

//     const outfit = combinedOutfits.find(o => o.id === editingOutfitId);
//     if (!outfit) return;

//     // Use TanStack Query mutation (optimistic update handled in hook)
//     updateOutfitMutation.mutate(
//       {
//         userId,
//         outfitId: editingOutfitId,
//         outfitType: outfit.type,
//         name: editedName.trim() || outfit.name,
//         occasion: editedOccasion ?? null,
//       },
//       {
//         onSuccess: () => {
//           // Reset modal state on success
//           setEditingOutfitId(null);
//           setEditedName('');
//           setEditedOccasion(undefined);
//         },
//         onError: err => {
//           console.error('Error updating outfit:', err);
//           Alert.alert('Error', 'Failed to update outfit in the database.');
//         },
//       },
//     );
//   };

//   // ✅ Delete outfit using TanStack Query mutation
//   const handleDelete = (id: string) => {
//     const deleted = combinedOutfits.find(o => o.id === id);
//     if (!deleted) return;

//     // Store for undo toast before optimistic delete
//     setLastDeletedOutfit(deleted);
//     setTimeout(() => setLastDeletedOutfit(null), 3000);

//     deleteOutfitMutation.mutate(
//       {userId, outfitId: id},
//       {
//         onError: err => {
//           console.error('Error deleting outfit:', err);
//           Alert.alert('Error', 'Could not delete outfit from the database.');
//           setLastDeletedOutfit(null);
//         },
//       },
//     );
//   };

//   // 📅 Local notification helpers
//   const scheduleOutfitLocalAlert = async (
//     outfitId: string,
//     outfitName: string | undefined,
//     when: Date,
//   ) => {
//     const title = 'Outfit Reminder';
//     const message = `Wear ${outfitName?.trim() || 'your planned outfit'}`;

//     console.log('🔔 Scheduling notification:', {
//       outfitId,
//       when: when.toISOString(),
//       whenLocal: when.toLocaleString(),
//       now: new Date().toISOString(),
//       nowLocal: new Date().toLocaleString(),
//     });

//     // @ts-ignore - id property exists but types may be outdated
//     PushNotification.localNotificationSchedule({
//       id: `outfit-${outfitId}`,
//       channelId: 'style-channel',
//       title,
//       message,
//       date: when,
//       allowWhileIdle: true,
//       playSound: true,
//       soundName: 'default',
//     });

//     // Also add to notification inbox so it shows in NotificationsScreen
//     await addToInbox(userId, {
//       user_id: userId,
//       id: `outfit-${outfitId}`,
//       title,
//       message,
//       timestamp: when.toISOString(),
//       category: 'outfit',
//       data: {screen: 'Planner'},
//       read: false,
//     });
//   };

//   // 👇 Custom slide-in-from-right animation
//   const slideInFromRight = {
//     from: {opacity: 0, translateX: 80},
//     to: {opacity: 1, translateX: 0},
//   };

//   // 🔄 Reset all scheduling state (Close / Cancel handlers)

//   const resetPlanFlow = async () => {
//     if (datePickerRef.current) {
//       await (datePickerRef.current as any).animate(
//         {
//           from: {opacity: 1, translateY: 0, scale: 1},
//           to: {opacity: 0, translateY: 60, scale: 0.97},
//         },
//         400,
//       );
//     }
//     setPlanningOutfitId(null);
//     setShowDatePicker(false);
//     setShowTimePicker(false);
//     setSelectedTempDate(null);
//     setSelectedTempTime(null);
//   };

//   const commitSchedule = async () => {
//     if (!planningOutfitId || !selectedTempDate || !selectedTempTime) return;
//     try {
//       const selectedOutfit = combinedOutfits.find(
//         o => o.id === planningOutfitId,
//       );
//       if (!selectedOutfit) return;

//       const outfit_type = selectedOutfit.type === 'custom' ? 'custom' : 'ai';
//       const combined = combineDateAndTime(selectedTempDate, selectedTempTime);

//       // clear any previous local alert + calendar event
//       cancelOutfitLocalAlert(planningOutfitId);
//       const oldKey = `outfitCalendar:${planningOutfitId}`;
//       const oldEventId = await AsyncStorage.getItem(oldKey);
//       if (oldEventId) {
//         await removeCalendarEvent(oldEventId);
//         await AsyncStorage.removeItem(oldKey);
//       }

//       // Save to server using TanStack Query mutation (optimistic update in hook)
//       scheduleOutfitMutation.mutate({
//         userId,
//         outfitId: planningOutfitId,
//         outfitType: outfit_type,
//         scheduledFor: combined.toISOString(),
//       });

//       // local notification + add to inbox
//       await scheduleOutfitLocalAlert(
//         planningOutfitId,
//         selectedOutfit.name,
//         combined,
//       );

//       // add to calendar & remember event id
//       const eventId = await addOutfitToCalendar({
//         title: selectedOutfit.name?.trim() || 'Outfit',
//         startISO: combined.toISOString(),
//         notes: selectedOutfit.notes || '',
//         alarmMinutesBefore: 0,
//       });
//       if (eventId) {
//         await AsyncStorage.setItem(
//           `outfitCalendar:${planningOutfitId}`,
//           eventId,
//         );
//       }
//     } catch (err) {
//       console.error('Failed to schedule outfit:', err);
//     } finally {
//       resetPlanFlow();
//     }
//   };

//   const cancelPlannedOutfit = async (outfitId: string) => {
//     // Cancel local alert first
//     cancelOutfitLocalAlert(outfitId);

//     // Remove calendar event (if any)
//     const key = `outfitCalendar:${outfitId}`;
//     const existingId = await AsyncStorage.getItem(key);
//     if (existingId) {
//       await removeCalendarEvent(existingId);
//       await AsyncStorage.removeItem(key);
//     }

//     // Use TanStack Query mutation (optimistic update in hook)
//     cancelScheduledOutfitMutation.mutate(
//       {userId, outfitId},
//       {
//         onError: err => {
//           console.error('Failed to cancel plan:', err);
//           Alert.alert('Error', 'Could not cancel the planned date.');
//         },
//       },
//     );
//   };

//   const cancelOutfitLocalAlert = (outfitId: string) => {
//     // @ts-ignore - cancelLocalNotification exists but types are outdated
//     PushNotification.cancelLocalNotification(`outfit-${outfitId}`);
//   };

//   // Check for schedule changes when component mounts or userId changes
//   // This handles updates made from CalendarPlannerScreen
//   const [lastScheduleCheck, setLastScheduleCheck] = useState<string | null>(
//     null,
//   );
//   useEffect(() => {
//     const checkScheduleChanges = async () => {
//       const changed = await AsyncStorage.getItem('schedulesChanged');
//       if (changed && changed !== lastScheduleCheck) {
//         setLastScheduleCheck(changed);
//         // Invalidate TanStack Query cache to refetch
//         invalidateSavedOutfits(userId);
//       }
//     };
//     checkScheduleChanges();
//     // Also check periodically when screen is visible
//     const interval = setInterval(checkScheduleChanges, 1000);
//     return () => clearInterval(interval);
//   }, [userId, lastScheduleCheck, invalidateSavedOutfits]);

//   // ✨ Sort state and computed outfits
//   const [sortType, setSortType] = useState<
//     'newest' | 'favorites' | 'planned' | 'stars'
//   >('newest');

//   // Filter by occasion first, then sort
//   const sortedOutfits = useMemo(() => {
//     const filteredOutfits = occasionFilter
//       ? displayOutfits.filter(o => o.occasion === occasionFilter)
//       : displayOutfits;

//     return [...filteredOutfits].sort((a, b) => {
//       switch (sortType) {
//         case 'favorites':
//           return Number(b.favorited) - Number(a.favorited);
//         case 'planned':
//           return (
//             new Date(b.plannedDate || 0).getTime() -
//             new Date(a.plannedDate || 0).getTime()
//           );
//         case 'stars':
//           return (b.rating || 0) - (a.rating || 0);
//         default:
//           return (
//             new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
//           );
//       }
//     });
//   }, [displayOutfits, occasionFilter, sortType]);

//   console.log('🎨 sortedOutfits:', {
//     sortedCount: sortedOutfits?.length,
//     occasionFilter,
//     sortType,
//   });

//   // Handle scroll for bottom nav hide/show
//   const handleScroll = useCallback(
//     (event: {nativeEvent: {contentOffset: {y: number}}}) => {
//       if (global.__navScrollY) {
//         global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
//       }
//     },
//     [],
//   );

//   // Share composite card size (matches community grid)
//   const SHARE_SIZE = 400;
//   const SHARE_CELL = SHARE_SIZE / 2;

//   // Memoized render item for FlashList
//   const renderOutfitItem = useCallback(
//     ({item: outfit, index}: {item: SavedOutfit; index: number}) => {
//       const isDemo = outfit.id.startsWith('demo-');

//       // For demo items, render matching the real card layout exactly
//       if (isDemo) {
//         return (
//           <View style={{paddingHorizontal: 6}}>
//             <View style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
//               {/* 🧵 Outfit Header Row */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   justifyContent: 'space-between',
//                   alignItems: 'center',
//                 }}>
//                 <View style={{flex: 1, marginRight: 12}}>
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       gap: 8,
//                     }}>
//                     <Text
//                       style={[
//                         globalStyles.titleBold,
//                         {
//                           fontSize: 20,
//                           color: theme.colors.foreground,
//                         },
//                       ]}>
//                       {outfit.name?.trim() || 'Unnamed Outfit'}
//                     </Text>
//                     <View
//                       style={{
//                         backgroundColor: 'black',
//                         paddingHorizontal: 8,
//                         paddingVertical: 3,
//                         borderRadius: 6,
//                       }}>
//                       <Text
//                         style={{
//                           color: 'white',
//                           fontSize: 11,
//                           fontWeight: tokens.fontWeight.semiBold,
//                         }}>
//                         Sample
//                       </Text>
//                     </View>
//                   </View>

//                   {/* Date info */}
//                   <View style={{marginTop: 6}}>
//                     <Text
//                       style={[
//                         styles.timestamp,
//                         {
//                           fontSize: 13,
//                           fontWeight: '600',
//                           color: theme.colors.foreground2,
//                         },
//                       ]}>
//                       Planned for Oct 5 at 10:14 AM
//                     </Text>
//                     <Text
//                       style={[
//                         styles.timestamp,
//                         {
//                           fontSize: 12,
//                           color: theme.colors.muted,
//                         },
//                       ]}>
//                       Saved Sep 18, 2025
//                     </Text>
//                   </View>
//                 </View>

//                 {/* ✏️ & ❤️ & 📤 Buttons (visual only) */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   {/* ✏️ Edit */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       marginRight: 6,
//                     }}>
//                     <MaterialIcons
//                       name="edit"
//                       size={20}
//                       color={theme.colors.foreground}
//                     />
//                   </View>

//                   {/* ❤️ Favorite */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                     }}>
//                     <MaterialIcons name="favorite" size={20} color="red" />
//                   </View>

//                   {/* 📤 Share */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       marginLeft: 6,
//                     }}>
//                     <MaterialIcons
//                       name="ios-share"
//                       size={20}
//                       color={theme.colors.primary}
//                     />
//                   </View>
//                 </View>
//               </View>

//               {/* 👕 Outfit Images - canvas outfits show snapshot + grid, legacy shows row */}
//               <View style={styles.imageRow}>
//                 {outfit.thumbnailUrl ? (
//                   <View style={{flexDirection: 'row', alignItems: 'flex-start'}}>
//                     {/* Left: Canvas snapshot */}
//                     <View style={{
//                       width: 130,
//                       height: 170,
//                       borderRadius: 12,
//                       overflow: 'hidden',
//                       backgroundColor: theme.colors.surface,
//                     }}>
//                       <FastImage
//                         source={{
//                           uri: outfit.thumbnailUrl,
//                           priority: FastImage.priority.normal,
//                           cache: FastImage.cacheControl.web,
//                         }}
//                         style={{
//                           width: 130,
//                           height: 170,
//                           borderRadius: 8,
//                         }}
//                         resizeMode={FastImage.resizeMode.contain}
//                       />
//                     </View>
//                     {/* Right: 4x3 Grid of individual items */}
//                     <View style={{marginLeft: 12, flexDirection: 'row', flexWrap: 'wrap', width: 164, gap: 4}}>
//                       {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((item, index) => {
//                         console.log(`🖼️ Grid item ${item?.id}: ${item?.image?.substring(0, 80)}`);
//                         return item?.image ? (
//                           <FastImage
//                             key={item.id || index}
//                             source={{
//                               uri: item.image,
//                               priority: FastImage.priority.normal,
//                               cache: FastImage.cacheControl.web,
//                             }}
//                             style={{width: 8, height: 38, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.muted}}
//                             resizeMode={FastImage.resizeMode.contain}
//                           />
//                         ) : null;
//                       })}
//                     </View>
//                   </View>
//                 ) : (
//                   (outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
//                     i?.image ? (
//                       <FastImage
//                         key={i.id || idx}
//                         source={{
//                           uri: i.image,
//                           priority: FastImage.priority.normal,
//                           cache: FastImage.cacheControl.web,
//                         }}
//                         style={[
//                           globalStyles.image1,
//                           {
//                             marginRight: 2,
//                             borderRadius: 8,
//                             marginBottom: 8,
//                             marginTop: -6,
//                           },
//                         ]}
//                         resizeMode={FastImage.resizeMode.contain}
//                       />
//                     ) : null,
//                   )
//                 )}
//               </View>

//               {/* Worn count & Occasion chip row */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   alignItems: 'center',
//                 }}>
//                 {/* Left 50% - Worn button & count */}
//                 <View
//                   style={{
//                     flex: 1,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   <View
//                     style={{
//                       paddingVertical: 4.5,
//                       borderRadius: 8,
//                       paddingHorizontal: 12,
//                       backgroundColor:
//                         theme.colors.button1 ?? 'rgba(43,43,43,1)',
//                     }}>
//                     <MaterialIcons
//                       name="checkroom"
//                       size={2}
//                       color={theme.colors.buttonText1}
//                     />
//                   </View>

//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       backgroundColor: theme.colors.surface,
//                       paddingHorizontal: 9,
//                       borderRadius: 12,
//                     }}>
//                     <Text
//                       style={{
//                         fontSize: 16,
//                         fontWeight: '700',
//                         color: theme.colors.foreground,
//                       }}>
//                       Worn:11 x{' '}
//                     </Text>
//                   </View>
//                 </View>

//                 {/* Right 50% - Occasion Chip */}
//                 <View
//                   style={{
//                     flex: 1,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     justifyContent: 'flex-start',
//                   }}>
//                   {outfit.occasion && OCCASION_CONFIG[outfit.occasion] && (
//                     <View
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         backgroundColor: OCCASION_CONFIG[outfit.occasion].color,
//                         paddingHorizontal: 14,
//                         paddingVertical: 9,
//                         borderRadius: 50,
//                       }}>
//                       <MaterialIcons
//                         name={OCCASION_CONFIG[outfit.occasion].icon as any}
//                         size={14}
//                         color={theme.colors.foreground}
//                         style={{marginRight: 5}}
//                       />
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           fontWeight: '600',
//                           color: theme.colors.foreground,
//                         }}>
//                         {OCCASION_CONFIG[outfit.occasion].label}
//                       </Text>
//                     </View>
//                   )}
//                 </View>
//               </View>

//               {/* Schedule & Cancel buttons */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   justifyContent: 'flex-start',
//                   flexWrap: 'wrap',
//                   marginTop: 8,
//                 }}>
//                 <View
//                   style={{
//                     backgroundColor: theme.colors.button1,
//                     borderRadius: 8,
//                     paddingVertical: 8,
//                     paddingHorizontal: 14,
//                     marginRight: 10,
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.buttonText1,
//                       fontWeight: '600',
//                       fontSize: 13,
//                     }}>
//                     Schedule This Outfit
//                   </Text>
//                 </View>

//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     paddingVertical: 8.5,
//                     paddingHorizontal: 14,
//                     borderRadius: 8,
//                     backgroundColor:
//                       theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.foreground,
//                       fontWeight: '600',
//                       fontSize: 13,
//                     }}>
//                     Cancel Schedule
//                   </Text>
//                 </View>
//               </View>

//               {/* Tags */}
//               {(outfit.tags || []).length > 0 && (
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     marginTop: 8,
//                   }}>
//                   {outfit.tags?.map(tag => (
//                     <View
//                       key={tag}
//                       style={{
//                         paddingHorizontal: 10,
//                         paddingVertical: 6,
//                         backgroundColor:
//                           theme.colors.input2 ?? 'rgba(43,43,43,1)',
//                         borderRadius: 16,
//                         marginRight: 6,
//                         marginBottom: 6,
//                       }}>
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           color: theme.colors.foreground,
//                         }}>
//                         #{tag}
//                       </Text>
//                     </View>
//                   ))}
//                 </View>
//               )}
//             </View>
//             <Text
//               style={{
//                 fontSize: 12,
//                 color: theme.colors.foreground2,
               
//                 textAlign: 'center',
//               }}>
//               Saved outfit cards will appear here ^
//             </Text>
//           </View>
//         );
//       }

//       return (
//         <SwipeableCard
//           key={outfit.id}
//           deleteThreshold={0.15}
//           onSwipeLeft={() => {
//             setPendingDeleteId(outfit.id);
//             setShowDeleteConfirm(true);
//           }}
//           deleteBackground={
//             <View
//               style={{
//                 flex: 1,
//                 alignItems: 'flex-end',
//                 justifyContent: 'center',
//                 paddingRight: 24,
//               }}
//             />
//           }>
//           <View style={{paddingHorizontal: 6}}>
//             <ViewShot
//               ref={ref => {
//                 viewRefs.current[outfit.id] = ref;
//               }}
//               options={{format: 'png', quality: 0.9}}>
//               <ScalePressable
//                 onPress={() => setFullScreenOutfit(outfit)}
//                 style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
//                 {/* 🧵 Outfit Header Row */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     justifyContent: 'space-between',
//                     alignItems: 'center',
//                   }}>
//                   <View style={{flex: 1, marginRight: 12}}>
//                     <View
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         gap: 8,
//                       }}>
//                       <Text
//                         style={[
//                           globalStyles.titleBold,
//                           {
//                             fontSize: 20,
//                             color: theme.colors.foreground,
//                             flex: 1,
//                           },
//                         ]}>
//                         {outfit.name?.trim() || 'Unnamed Outfit'}
//                       </Text>
//                     </View>

//                     {/* 🗓️ Date & Time Info */}
//                     {(outfit.createdAt || outfit.plannedDate) && (
//                       <View style={{marginTop: 6}}>
//                         {outfit.plannedDate && (
//                           <Text
//                             style={[
//                               styles.timestamp,
//                               {
//                                 fontSize: 13,
//                                 fontWeight: '600',
//                                 color: theme.colors.foreground2,
//                               },
//                             ]}>
//                             {`Planned for ${new Date(
//                               outfit.plannedDate,
//                             ).toLocaleString([], {
//                               month: 'short',
//                               day: 'numeric',
//                               hour: 'numeric',
//                               minute: '2-digit',
//                             })}`}
//                           </Text>
//                         )}
//                         {outfit.createdAt && (
//                           <Text
//                             style={[
//                               styles.timestamp,
//                               {
//                                 fontSize: 12,
//                                 color: theme.colors.muted,
//                               },
//                             ]}>
//                             {`Saved ${new Date(
//                               outfit.createdAt,
//                             ).toLocaleDateString([], {
//                               month: 'short',
//                               day: 'numeric',
//                               year: 'numeric',
//                             })}`}
//                           </Text>
//                         )}
//                       </View>
//                     )}
//                   </View>

//                   {/* ❤️ & ✏️ & 👕 Buttons */}
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                     }}>
//                     {/* ✏️ Edit */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         setEditingOutfitId(outfit.id);
//                         setEditedName(outfit.name || '');
//                         setEditedOccasion(outfit.occasion);
//                       }}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                         marginRight: 6,
//                       }}>
//                       <MaterialIcons
//                         name="edit"
//                         size={20}
//                         color={theme.colors.foreground}
//                       />
//                     </Pressable>

//                     {/* ❤️ Favorite */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         toggleFavorite(
//                           outfit.id,
//                           outfit.type === 'custom' ? 'custom' : 'suggestion',
//                         );
//                       }}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <MaterialIcons
//                         name="favorite"
//                         size={20}
//                         color={
//                           favorites.some(
//                             f =>
//                               f.id === outfit.id &&
//                               f.source ===
//                                 (outfit.type === 'custom'
//                                   ? 'custom'
//                                   : 'suggestion'),
//                           )
//                             ? 'red'
//                             : theme.colors.foreground
//                         }
//                       />
//                     </Pressable>
//                     {/* 📤 Share */}
//                     <Pressable
//                       onPress={() => handleSharePress(outfit)}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                         marginLeft: 6,
//                       }}>
//                       <MaterialIcons
//                         name="ios-share"
//                         size={20}
//                         color={theme.colors.primary}
//                       />
//                     </Pressable>
//                   </View>
//                 </View>

//                 {/* 👕 Outfit Images - canvas outfits show snapshot + grid, legacy shows row */}
//                 <View style={styles.imageRow}>
//                   {outfit.thumbnailUrl ? (
//                     <View style={{flexDirection: 'row', alignItems: 'flex-start'}}>
//                       {/* Left: Canvas snapshot */}
//                       <View style={{
//                         width: 130,
//                         height: 210,
//                         overflow: 'hidden',
//                         backgroundColor: theme.colors.surface,
//                         // borderColor: theme.colors.muted,
//                         // borderRadius: 8,
//                         // borderWidth: 1,
//                         marginBottom: 4
//                       }}>
//                         <FastImage
//                           source={{
//                             uri: outfit.thumbnailUrl,
//                             priority: FastImage.priority.normal,
//                             cache: FastImage.cacheControl.web,
//                           }}
//                           style={{
//                             width: 130,
//                             height: 210,
//                             borderRadius: 8,
                       
//                           }}
//                           resizeMode={FastImage.resizeMode.contain}
//                         />
//                       </View>
//                       {/* Right: 4x3 Grid of individual items */}
//                       <View style={{marginLeft: 12, flexDirection: 'row', flexWrap: 'wrap', width: 250, gap: 4}}>
//                         {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((item, index) => {
//                           console.log(`🖼️ Grid item (2) ${item?.id}: ${item?.image?.substring(0, 80)}`);
//                           return item?.image ? (
//                             <FastImage
//                               key={item.id || index}
//                               source={{
//                                 uri: item.image,
//                                 priority: FastImage.priority.normal,
//                                 cache: FastImage.cacheControl.web,
//                               }}
//                               style={{width: 55, height: 55, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.muted}}
//                               resizeMode={FastImage.resizeMode.contain}
//                             />
//                           ) : null;
//                         })}
//                       </View>
//                     </View>
//                   ) : (
//                     (outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
//                       i?.image ? (
//                         <FastImage
//                           key={i.id || idx}
//                           source={{
//                             uri: i.image,
//                             priority: FastImage.priority.normal,
//                             cache: FastImage.cacheControl.web,
//                           }}
//                           style={[
//                             globalStyles.image1,
//                             {
//                               marginRight: 2,
//                               borderRadius: 8,
//                               marginBottom: 8,
//                               marginTop: -6,
//                             },
//                           ]}
//                           resizeMode={FastImage.resizeMode.contain}
//                         />
//                       ) : null,
//                     )
//                   )}
//                 </View>

//                 {/* 📝 Notes */}
//                 {outfit.notes?.trim() && (
//                   <Text style={styles.notes}>"{outfit.notes.trim()}"</Text>
//                 )}

//                 {/* WORN COLOR */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   {/* Left 50% */}
//                   <View
//                     style={{
//                       flex: 1,
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                     }}>
//                     {/* 👕 Mark as worn (tap to increment, long press to decrement) */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         markWornMutation.mutate({
//                           userId,
//                           outfitId: outfit.id,
//                           outfitType: outfit.type,
//                         });
//                       }}
//                       onLongPress={() => {
//                         if ((outfit.timesWorn ?? 0) <= 0) return;
//                         hSelect();
//                         unmarkWornMutation.mutate({
//                           userId,
//                           outfitId: outfit.id,
//                           outfitType: outfit.type,
//                         });
//                       }}
//                       delayLongPress={500}
//                       style={{
//                         paddingVertical: 4.5,
//                         borderRadius: 8,
//                         paddingHorizontal: 12,
//                         backgroundColor:
//                           theme.colors.button1 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <MaterialIcons
//                         name="checkroom"
//                         size={22}
//                         color={theme.colors.buttonText1}
//                       />
//                     </Pressable>

//                     {(outfit.timesWorn ?? 0) > 0 && (
//                       <View
//                         style={{
//                           flexDirection: 'row',
//                           alignItems: 'center',
//                           backgroundColor: theme.colors.surface,
//                           paddingHorizontal: 9,
//                           borderRadius: 12,
//                         }}>
//                         <Text
//                           style={{
//                             fontSize: 16,
//                             fontWeight: '700',
//                             color: theme.colors.foreground,
//                           }}>
//                           Worn:
//                           {outfit.timesWorn} x{' '}
//                         </Text>
//                       </View>
//                     )}
//                   </View>

//                   {/* Right 50% - Occasion Chip */}
//                   <View
//                     style={{
//                       flex: 1,
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       justifyContent: 'flex-start',
//                     }}>
//                     {outfit.occasion && OCCASION_CONFIG[outfit.occasion] && (
//                       <Pressable
//                         onPress={() => {
//                           hSelect();
//                           setEditingOutfitId(outfit.id);
//                           setEditedName(outfit.name || '');
//                           setEditedOccasion(outfit.occasion);
//                         }}
//                         style={{
//                           flexDirection: 'row',
//                           alignItems: 'center',
//                           backgroundColor: `${
//                             OCCASION_CONFIG[outfit.occasion].color
//                           }`,
//                           paddingHorizontal: 14,
//                           paddingVertical: 9,
//                           borderRadius: 50,
//                         }}>
//                         <MaterialIcons
//                           name={OCCASION_CONFIG[outfit.occasion].icon as any}
//                           size={14}
//                           color={theme.colors.foreground}
//                           style={{marginRight: 5}}
//                         />
//                         <Text
//                           style={{
//                             fontSize: 12,
//                             fontWeight: '600',
//                             color: theme.colors.foreground,
//                           }}>
//                           {OCCASION_CONFIG[outfit.occasion].label}
//                         </Text>
//                       </Pressable>
//                     )}
//                   </View>
//                 </View>

//                 {/* 📅 Schedule & Cancel Buttons – keep them working */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     justifyContent: 'flex-start',
//                     flexWrap: 'wrap',
//                     marginTop: 8,
//                   }}>
//                   <AppleTouchFeedback
//                     hapticStyle="impactLight"
//                     onPress={() => {
//                       setPlanningOutfitId(outfit.id);
//                       const now = new Date();
//                       setSelectedTempDate(now);
//                       setSelectedTempTime(now);
//                       setShowDatePicker(true);
//                     }}
//                     style={{
//                       backgroundColor: theme.colors.button1,
//                       borderRadius: 8,
//                       paddingVertical: 8,
//                       paddingHorizontal: 14,
//                       marginRight: 10,
//                     }}>
//                     <Text
//                       style={{
//                         color: theme.colors.buttonText1,
//                         fontWeight: '600',
//                         fontSize: 13,
//                       }}>
//                       Schedule This Outfit
//                     </Text>
//                   </AppleTouchFeedback>

//                   {outfit.plannedDate && (
//                     <AppleTouchFeedback
//                       hapticStyle="impactLight"
//                       onPress={() => {
//                         cancelPlannedOutfit(outfit.id);
//                       }}
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         paddingVertical: 8.5,
//                         paddingHorizontal: 14,
//                         borderRadius: 8,
//                         marginLeft: 16,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <Text
//                         style={{
//                           color: theme.colors.foreground,
//                           fontWeight: '600',
//                           fontSize: 13,
//                         }}>
//                         Cancel Schedule
//                       </Text>
//                     </AppleTouchFeedback>
//                   )}
//                 </View>

//                 {/* 🏷️ Tags */}
//                 {(outfit.tags || []).length > 0 && (
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       flexWrap: 'wrap',
//                       marginTop: 8,
//                     }}>
//                     {outfit.tags?.map(tag => (
//                       <View
//                         key={tag}
//                         style={{
//                           paddingHorizontal: 10,
//                           paddingVertical: 6,
//                           backgroundColor:
//                             theme.colors.input2 ?? 'rgba(43,43,43,1)',
//                           borderRadius: 16,
//                           marginRight: 6,
//                           marginBottom: 6,
//                         }}>
//                         <Text
//                           style={{
//                             fontSize: 12,
//                             color: theme.colors.foreground,
//                           }}>
//                           #{tag}
//                         </Text>
//                       </View>
//                     ))}
//                   </View>
//                 )}
//               </ScalePressable>
//             </ViewShot>
//           </View>
//         </SwipeableCard>
//       );
//     },
//     [
//       favorites,
//       theme,
//       globalStyles,
//       styles,
//       userId,
//       toggleFavorite,
//       markWornMutation,
//       unmarkWornMutation,
//       outfitsState,
//     ],
//   );

//   const keyExtractor = useCallback((item: SavedOutfit) => item.id, []);

//   // Override item layout for FlashList optimization
//   const overrideItemLayout = useCallback(
//     (layout: {span?: number; size?: number}): void => {
//       layout.size = ESTIMATED_CARD_HEIGHT;
//     },
//     [],
//   );

//   // 🔲 Grid View: minimal 2-column thumbnail + name only /
//   // Sized so exactly 3 rows are visible on screen
//   const GRID_GAP = 10;
//   const GRID_PADDING_H = 10;
//   const GRID_ITEM_WIDTH = (SCREEN_WIDTH - GRID_PADDING_H * 2 - GRID_GAP) / 2;
//   const GRID_VISIBLE_ROWS = 3;
//   const GRID_NAME_HEIGHT = 35; // text + padding
//   // Available height for grid = screen minus header/sort/chips/nav (~280px approx)
//   const GRID_AVAILABLE_HEIGHT = Dimensions.get('window').height - 300;
//   const GRID_ROW_HEIGHT = Math.floor(
//     (GRID_AVAILABLE_HEIGHT - GRID_GAP * (GRID_VISIBLE_ROWS - 1)) /
//       GRID_VISIBLE_ROWS,
//   );
//   const GRID_IMAGE_HEIGHT = GRID_ROW_HEIGHT - GRID_NAME_HEIGHT;

//   const renderGridItem = useCallback(
//     ({item: outfit}: {item: SavedOutfit}) => {
//       // Pick best available thumbnail: thumbnailUrl > top image > first allItem image
//       const thumbUri =
//         outfit.thumbnailUrl ||
//         outfit.top?.image ||
//         (outfit.allItems && outfit.allItems.length > 0
//           ? outfit.allItems[0]?.image
//           : undefined);

//       return (
//         <TouchableOpacity
//           activeOpacity={0.85}
//           onPress={() => setFullScreenOutfit(outfit)}
//           style={{
//             width: GRID_ITEM_WIDTH,
//             height: GRID_ROW_HEIGHT,
//             marginBottom: GRID_GAP,
//             borderRadius: 16,
//             overflow: 'hidden',
//             backgroundColor: theme.colors.surface,
//             borderWidth: StyleSheet.hairlineWidth,
//             borderColor: theme.colors.surfaceBorder,
//           }}>
//           {thumbUri ? (
//             <FastImage
//               source={{
//                 uri: thumbUri,
//                 priority: FastImage.priority.normal,
//                 cache: FastImage.cacheControl.web,
//               }}
//               style={{
//                 width: '100%',
//                 height: GRID_IMAGE_HEIGHT,
//                 backgroundColor: theme.colors.surface,
//               }}
//               resizeMode={FastImage.resizeMode.contain}
//             />
//           ) : (
//             <View
//               style={{
//                 width: '100%',
//                 height: GRID_IMAGE_HEIGHT,
//                 backgroundColor: theme.colors.surface3,
//                 alignItems: 'center',
//                 justifyContent: 'center',
//               }}>
//               <MaterialIcons
//                 name="checkroom"
//                 size={36}
//                 color={theme.colors.muted}
//               />
//             </View>
//           )}
//           <Text
//             numberOfLines={1}
//             ellipsizeMode="tail"
//             style={{
//               fontSize: 13,
//               fontWeight: '600',
//               color: theme.colors.foreground,
//               paddingHorizontal: 10,
//               paddingVertical: 9,
//             }}>
//             {outfit.name?.trim() || 'Unnamed Outfit'}
//           </Text>
//         </TouchableOpacity>
//       );
//     },
//     [theme, GRID_ITEM_WIDTH, GRID_ROW_HEIGHT, GRID_IMAGE_HEIGHT],
//   );

//   // Sort/Filter popover submenu transition (matches ClosetScreen pattern)
//   const openSubmenu = (view: 'sort' | 'filter') => {
//     setMenuView(view);
//     submenuOpacity.setValue(0);
//     Animated.timing(submenuOpacity, {
//       toValue: 1,
//       duration: 180,
//       useNativeDriver: true,
//     }).start();
//   };

//   return (
//     <SafeAreaView
//       edges={['top']}
//       style={[
//         globalStyles.screen,
//         globalStyles.container,
//         {backgroundColor: theme.colors.background, paddingBottom: 0},
//       ]}>
//       {/* Hidden 2x2 grid composite for sharing */}
//       {shareOutfit && (
//         <View style={{position: 'absolute', left: -9999, top: -9999}}>
//           <ViewShot
//             ref={shareCompositeRef}
//             options={{format: 'png', quality: 0.95}}
//             style={{
//               width: SHARE_SIZE,
//               height: SHARE_SIZE + 80,
//               backgroundColor: '#F5F5F5',
//             }}>
//             {/* 2x2 Grid */}
//             {/* Row 1 */}
//             <View style={{flexDirection: 'row', height: SHARE_CELL}}>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.top?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderBottomWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.bottom?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//             </View>
//             {/* Row 2 */}
//             <View style={{flexDirection: 'row', height: SHARE_CELL}}>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderRightWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.shoes?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//               {/* Plain off-white cell */}
//               <View
//                 style={{
//                   width: SHARE_CELL,
//                   height: SHARE_CELL,
//                   backgroundColor: '#F5F5F5',
//                 }}
//               />
//             </View>

//             {/* Center watermark with tinted overlay */}
//             <View
//               style={{
//                 position: 'absolute',
//                 top: 0,
//                 left: 0,
//                 right: 0,
//                 bottom: 80,
//                 justifyContent: 'center',
//                 alignItems: 'center',
//               }}>
//               <View
//                 style={{
//                   backgroundColor: 'rgba(0,0,0,0.5)',
//                   paddingHorizontal: 32,
//                   paddingVertical: 16,
//                   borderRadius: 40,
//                   borderWidth: 1.5,
//                   borderColor: 'rgba(255,255,255,0.25)',
//                   shadowColor: '#000',
//                   shadowOffset: {width: 0, height: 4},
//                   shadowOpacity: 0.4,
//                   shadowRadius: 12,
//                 }}>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     fontSize: 10,
//                     fontWeight: '500',
//                     letterSpacing: 0.5,
//                     textAlign: 'center',
//                     marginBottom: 4,
//                   }}>
//                   Created on
//                 </Text>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     fontSize: 28,
//                     fontWeight: '800',
//                     letterSpacing: 1.5,
//                     textShadowColor: 'rgba(0,0,0,0.5)',
//                     textShadowOffset: {width: 0, height: 2},
//                     textShadowRadius: 4,
//                   }}>
//                   StylHelpr
//                 </Text>
//               </View>
//             </View>

//             {/* Bottom info section */}
//             <View
//               style={{
//                 height: 80,
//                 backgroundColor: 'rgba(144, 0, 255, 1)',
//                 paddingHorizontal: 20,
//                 paddingVertical: 16,
//               }}>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '700',
//                   color: '#fff',
//                   marginBottom: 8,
//                 }}
//                 numberOfLines={1}>
//                 {shareOutfit.name || 'My Outfit'}
//               </Text>
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   alignItems: 'center',
//                   justifyContent: 'space-between',
//                 }}>
//                 <View style={{flexDirection: 'row', alignItems: 'center'}}>
//                   <View
//                     style={{
//                       width: 24,
//                       height: 24,
//                       borderRadius: 12,
//                       marginRight: 8,
//                       backgroundColor: '#000',
//                       overflow: 'hidden',
//                       justifyContent: 'center',
//                       alignItems: 'center',
//                     }}>
//                     {profilePicture ? (
//                       <Image
//                         source={{uri: profilePicture}}
//                         style={{
//                           width: 24,
//                           height: 24,
//                         }}
//                       />
//                     ) : (
//                       <Text
//                         style={{
//                           color: '#fff',
//                           fontSize: 10,
//                           fontWeight: '700',
//                         }}>
//                         SH
//                       </Text>
//                     )}
//                   </View>
//                   <Text
//                     style={{
//                       fontSize: 14,
//                       fontWeight: '500',
//                       color: '#fff',
//                     }}
//                     numberOfLines={1}>
//                     @{userName.toLowerCase() || 'stylhelpr'}
//                   </Text>
//                 </View>
//                 <Text
//                   style={{
//                     fontSize: 12,
//                     fontWeight: '400',
//                     color: 'rgba(255,255,255,0.8)',
//                   }}>
//                   {new Date(shareOutfit.createdAt).toLocaleDateString()}
//                 </Text>
//               </View>
//             </View>
//           </ViewShot>
//         </View>
//       )}

//       {/* 🧭 Spacer to restore old navbar height */}
//       <View
//         style={{
//           height: Math.max(insets.top - 10, 44), // ✅ min 44px for non-notched devices
//           backgroundColor: theme.colors.background
//         }}
//       />
//       <View
//         style={{
//           flexDirection: 'row',
//           alignItems: 'center',
//           justifyContent: 'space-between',
//         }}>
//         <Text
//           style={[
//             globalStyles.header,
//             {color: theme.colors.primary, marginBottom: 0},
//           ]}>
//           Saved Outfits
//         </Text>
//         <View style={{flexDirection: 'row', gap: 8}}>
//           <TouchableOpacity
//             onPress={() => {
//               hSelect();
//               setMenuVisible(prev => !prev);
//               setMenuView('main');
//             }}
//             style={{
//               padding: 8,
//               borderRadius: 20,
//               backgroundColor: menuVisible
//                 ? theme.colors.primary
//                 : theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name="filter-list"
//               size={24}
//               color={menuVisible ? '#fff' : theme.colors.primary}
//             />
//           </TouchableOpacity>
//           <TouchableOpacity
//             onPress={() => {
//               hSelect();
//               setViewMode(prev => (prev === 'list' ? 'grid' : 'list'));
//             }}
//             style={{
//               padding: 8,
//               borderRadius: 20,
//               backgroundColor: theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name={viewMode === 'grid' ? 'view-agenda' : 'grid-view'}
//               size={24}
//               color={theme.colors.primary}
//             />
//           </TouchableOpacity>
//           <TouchableOpacity
//             onPress={() => globalNavigate('OutfitsByOccasion')}
//             style={{
//               padding: 8,
//               borderRadius: 20,
//               backgroundColor: theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name="category"
//               size={24}
//               color={theme.colors.primary}
//             />
//           </TouchableOpacity>
//           <TouchableOpacity
//             onPress={() => globalNavigate('OutfitHistory')}
//             style={{
//               padding: 8,
//               marginRight: 16,
//               borderRadius: 20,
//               backgroundColor: theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name="history"
//               size={24}
//               color={theme.colors.primary}
//             />
//           </TouchableOpacity>
//         </View>
//       </View>

//       {/* Active filter/sort indicator chips */}
//       {(sortType !== 'newest' || occasionFilter !== null) && (
//         <View
//           style={{
//             flexDirection: 'row',
//             paddingHorizontal: 16,
//             paddingVertical: 6,
//             gap: 8,
//             flexWrap: 'wrap',
//           }}>
//           {sortType !== 'newest' && (
//             <View
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: theme.colors.primary + '20',
//                 paddingHorizontal: 10,
//                 paddingVertical: 5,
//                 borderRadius: 12,
//                 gap: 4,
//               }}>
//               <MaterialIcons name="sort" size={14} color={theme.colors.primary} />
//               <Text style={{fontSize: 12, fontWeight: '600', color: theme.colors.primary}}>
//                 {sortType === 'favorites' ? 'Favorites' : sortType === 'planned' ? 'Planned' : 'Rating'}
//               </Text>
//               <TouchableOpacity onPress={() => setSortType('newest')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
//                 <MaterialIcons name="close" size={14} color={theme.colors.primary} />
//               </TouchableOpacity>
//             </View>
//           )}
//           {occasionFilter !== null && OCCASION_CONFIG[occasionFilter] && (
//             <View
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: OCCASION_CONFIG[occasionFilter].color + '25',
//                 paddingHorizontal: 10,
//                 paddingVertical: 5,
//                 borderRadius: 12,
//                 gap: 4,
//               }}>
//               <MaterialIcons
//                 name={OCCASION_CONFIG[occasionFilter].icon as any}
//                 size={14}
//                 color={OCCASION_CONFIG[occasionFilter].color}
//               />
//               <Text style={{fontSize: 12, fontWeight: '600', color: OCCASION_CONFIG[occasionFilter].color}}>
//                 {OCCASION_CONFIG[occasionFilter].label}
//               </Text>
//               <TouchableOpacity onPress={() => setOccasionFilter(null)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
//                 <MaterialIcons name="close" size={14} color={OCCASION_CONFIG[occasionFilter].color} />
//               </TouchableOpacity>
//             </View>
//           )}
//         </View>
//       )}

//       {/* Demo indicator banner */}
//       {outfitsState === 'demo' && (
//         <View
//           style={{
//             backgroundColor: theme.colors.primary + '20',
//             paddingVertical: 10,
//             paddingHorizontal: 16,
//             marginHorizontal: 16,
//             marginBottom: 12,
//             borderRadius: 10,
//             flexDirection: 'row',
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="info-outline"
//             size={20}
//             color={theme.colors.primary}
//             style={{marginRight: 8}}
//           />
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               fontSize: 14,
//               flex: 1,
//             }}>
//             This is a sample outfit card. Build your own outfits in "Wardrobe" or have "AI Outfit" create one and save them!
//           </Text>
//         </View>
//       )}

//       {/* 🪩 Virtualized FlashList / Grid View */}
//       <View style={{flex: 1, width: '100%', marginTop:12}}>
//         {/* Empty state - only show when user had outfits before but now has none */}
//         {outfitsState === 'empty-real' && sortedOutfits.length === 0 ? (
//           <View
//             style={{
//               flexDirection: 'row',
//               alignSelf: 'center',
//               paddingTop: 40,
//             }}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved outfits.
//             </Text>
//             <TooltipBubble
//               message="You don't have any saved outfits yet. Tap Wardrobe in the bottom navigation bar to head to the Wardrobe screen, and then tap Build an Outfit. Once you build your first outfit, it will appear back here automatically."
//               position="top"
//             />
//           </View>
//         ) : sortedOutfits.length > 0 ? (
//           viewMode === 'grid' ? (
//             <FlatList
//               data={sortedOutfits}
//               renderItem={renderGridItem}
//               keyExtractor={keyExtractor}
//               numColumns={2}
//               columnWrapperStyle={{
//                 justifyContent: 'space-between',
//                 paddingHorizontal: GRID_PADDING_H,
//               }}
//               showsVerticalScrollIndicator={false}
//               onScroll={handleScroll}
//               scrollEventThrottle={16}
//               contentContainerStyle={{
//                 paddingBottom: 160,
//                 paddingTop: 4,
//               }}
//             />
//           ) : (
//             <FlashList
//               ref={flashListRef}
//               data={sortedOutfits}
//               renderItem={renderOutfitItem}
//               keyExtractor={keyExtractor}
//               overrideItemLayout={overrideItemLayout}
//               drawDistance={ESTIMATED_CARD_HEIGHT * 2}
//               showsVerticalScrollIndicator={false}
//               onScroll={handleScroll}
//               scrollEventThrottle={16}
//               contentContainerStyle={{
//                 paddingBottom: 160,
//                 paddingHorizontal: 10,
//               }}
//             />
//           )
//         ) : null}
//       </View>

//       {/* 📝 Edit Outfit Modal */}
//       {editingOutfitId && (
//         <BlurView
//           style={styles.modalContainer}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             animation="zoomIn"
//             duration={600}
//             style={[styles.modalContent, {maxHeight: '80%'}]}>
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontWeight: '700',
//                 fontSize: 18,
//                 marginBottom: 4,
//               }}>
//               Edit Outfit
//             </Text>

//             {/* Outfit Name Input */}
//             <Text
//               style={{
//                 color: theme.colors.foreground3,
//                 fontSize: 12,
//                 fontWeight: '600',
//                 marginTop: 12,
//                 marginBottom: 6,
//               }}>
//               NAME
//             </Text>
//             <TextInput
//               value={editedName}
//               onChangeText={setEditedName}
//               placeholder="Enter outfit name"
//               placeholderTextColor={theme.colors.foreground3}
//               style={styles.input}
//             />

//             {/* Occasion Selector */}
//             <Text
//               style={{
//                 color: theme.colors.foreground3,
//                 fontSize: 12,
//                 fontWeight: '600',
//                 marginTop: 16,
//                 marginBottom: 8,
//               }}>
//               OCCASION
//             </Text>

//             <ScrollView
//               horizontal
//               showsHorizontalScrollIndicator={false}
//               style={{marginBottom: 8}}>
//               <View style={{flexDirection: 'row', gap: 8, paddingRight: 16}}>
//                 {/* Clear occasion option */}
//                 <Pressable
//                   onPress={() => setEditedOccasion(undefined)}
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     paddingHorizontal: 12,
//                     paddingVertical: 8,
//                     borderRadius: 16,
//                     backgroundColor: !editedOccasion
//                       ? theme.colors.primary
//                       : theme.colors.surface3,
//                     borderWidth: 1,
//                     borderColor: !editedOccasion
//                       ? theme.colors.primary
//                       : theme.colors.surfaceBorder,
//                   }}>
//                   <MaterialIcons
//                     name="close"
//                     size={14}
//                     color={!editedOccasion ? '#fff' : theme.colors.foreground3}
//                     style={{marginRight: 4}}
//                   />
//                   <Text
//                     style={{
//                       fontSize: 12,
//                       fontWeight: '600',
//                       color: !editedOccasion
//                         ? '#fff'
//                         : theme.colors.foreground3,
//                     }}>
//                     None
//                   </Text>
//                 </Pressable>

//                 {/* Occasion options */}
//                 {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(key => {
//                   const config = OCCASION_CONFIG[key];
//                   const isSelected = editedOccasion === key;
//                   return (
//                     <Pressable
//                       key={key}
//                       onPress={() => setEditedOccasion(key)}
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         paddingHorizontal: 12,
//                         paddingVertical: 10,
//                         borderRadius: 16,
//                         backgroundColor: isSelected
//                           ? `${config.color}`
//                           : theme.colors.surface3,
//                         borderWidth: 1,
//                         borderColor: isSelected
//                           ? config.color
//                           : theme.colors.surfaceBorder,
//                       }}>
//                       <MaterialIcons
//                         name={config.icon as any}
//                         size={14}
//                         color={theme.colors.foreground3}
//                         style={{marginRight: 4}}
//                       />
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           fontWeight: '600',
//                           color: theme.colors.foreground3,
//                         }}>
//                         {config.label}
//                       </Text>
//                     </Pressable>
//                   );
//                 })}
//               </View>
//             </ScrollView>

//             <View style={[styles.modalActions, {marginTop: 16}]}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   setEditingOutfitId(null);
//                   setEditedName('');
//                   setEditedOccasion(undefined);
//                 }}>
//                 <Text style={{color: theme.colors.foreground, marginRight: 24}}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={handleNameSave}>
//                 <Text style={{color: theme.colors.primary, fontWeight: '700'}}>
//                   Save
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Animatable.View>
//         </BlurView>
//       )}

//       {/* 📅 Date/Time Picker — Combined Bottom Sheet */}
//       {(showDatePicker || showTimePicker) && planningOutfitId && (
//         <BlurView
//           style={[styles.overlay, {marginTop: 0}]}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             ref={datePickerRef}
//             animation="fadeInUp"
//             duration={1000}
//             easing="ease-out-quint"
//             style={[styles.sheetContainer]}>
//             <View style={styles.grabber} />
//             <View style={styles.sheetHeaderRow}>
//               <Text style={styles.sheetTitle}>
//                 {showDatePicker ? 'Pick a date' : 'Pick a time'}
//               </Text>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={resetPlanFlow}
//                 style={styles.sheetPill}>
//                 <Text style={styles.sheetPillText}>Close</Text>
//               </AppleTouchFeedback>
//             </View>

//             <View
//               style={{
//                 position: 'relative',
//                 backgroundColor: showDatePicker
//                   ? theme.colors.background
//                   : theme.colors.background,
//                 borderRadius: 25,
//                 paddingBottom: insets.bottom + 10,
//                 paddingTop: showDatePicker ? 6 : 12,
//                 alignItems: 'center',
//                 overflow: 'hidden',
//               }}>
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 0,
//                   left: 0,
//                   right: 0,
//                   bottom: 0,
//                   opacity: showDatePicker ? 1 : 0,
//                   pointerEvents: showDatePicker ? 'auto' : 'none',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <DateTimePicker
//                   value={selectedTempDate || new Date()}
//                   mode="date"
//                   display="spinner"
//                   themeVariant="dark"
//                   textColor={theme.colors.foreground}
//                   onChange={(e, d) => d && setSelectedTempDate(new Date(d))}
//                   style={{marginVertical: -10}}
//                 />
//               </View>
//               <View
//                 style={{
//                   opacity: showTimePicker ? 1 : 0,
//                   pointerEvents: showTimePicker ? 'auto' : 'none',
//                 }}>
//                 <DateTimePicker
//                   value={selectedTempTime || new Date()}
//                   mode="time"
//                   display="spinner"
//                   textColor={theme.colors.foreground}
//                   onChange={(e, t) => t && setSelectedTempTime(new Date(t))}
//                   style={{
//                     width: '100%',
//                     transform: [{scale: 1.05}],
//                     opacity: 1.0,
//                   }}
//                 />
//               </View>
//             </View>

//             <View style={styles.sheetFooterRow}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={resetPlanFlow}
//                 style={[
//                   styles.sheetPill,
//                   {
//                     backgroundColor: showDatePicker
//                       ? theme.colors.surface
//                       : theme.colors.input2,
//                   },
//                 ]}>
//                 <Text style={styles.sheetPillText}>Cancel</Text>
//               </AppleTouchFeedback>
//               {showDatePicker ? (
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setShowTimePicker(true);
//                     setShowDatePicker(false);
//                   }}
//                   style={[
//                     styles.sheetPill,
//                     {backgroundColor: theme.colors.background},
//                   ]}>
//                   <Text
//                     style={{color: theme.colors.foreground, fontWeight: '800'}}>
//                     Next: Time
//                   </Text>
//                 </AppleTouchFeedback>
//               ) : (
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={commitSchedule}
//                   style={[
//                     styles.sheetPill,
//                     {backgroundColor: theme.colors.button1},
//                   ]}>
//                   <Text
//                     style={{
//                       color: theme.colors.buttonText1,
//                       fontWeight: '800',
//                     }}>
//                     Done
//                   </Text>
//                 </AppleTouchFeedback>
//               )}
//             </View>
//           </Animatable.View>
//         </BlurView>
//       )}

//       {/* 🧼 Deleted Toast (undo not available since delete is server-side) */}
//       {lastDeletedOutfit && (
//         <Animatable.View
//           animation="bounceInUp"
//           duration={800}
//           easing="ease-out-back"
//           style={styles.toast}>
//           <Text style={{color: theme.colors.foreground}}>Outfit deleted</Text>
//         </Animatable.View>
//       )}

//       {/* 🗑 Delete Confirmation */}
//       <Modal
//         visible={showDeleteConfirm && !!pendingDeleteId}
//         transparent
//         animationType="fade">
//         <BlurView
//           style={styles.modalContainer}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             animation="zoomIn"
//             duration={500}
//             style={styles.modalContent}>
//             <Text
//               style={{
//                 fontSize: 16,
//                 color: theme.colors.foreground,
//                 fontWeight: '700',
//                 marginBottom: 8,
//               }}>
//               Delete this outfit?
//             </Text>
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//               }}>
//               This action cannot be undone.
//             </Text>
//             <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   setShowDeleteConfirm(false);
//                   setPendingDeleteId(null);
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     marginHorizontal: 16,
//                   }}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>
//               <AppleTouchFeedback
//                 hapticStyle="notificationWarning"
//                 onPress={() => {
//                   if (pendingDeleteId) handleDelete(pendingDeleteId);
//                   setShowDeleteConfirm(false);
//                   setPendingDeleteId(null);
//                 }}>
//                 <Text style={{color: theme.colors.error, fontWeight: '800'}}>
//                   Delete
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Animatable.View>
//         </BlurView>
//       </Modal>

//       {/* 📤 Share Options Modal */}
//       <Modal
//         visible={shareOptionsVisible}
//         transparent
//         animationType="fade"
//         onRequestClose={() => setShareOptionsVisible(false)}>
//         <Pressable
//           style={styles.modalContainer}
//           onPress={() => setShareOptionsVisible(false)}>
//           <BlurView
//             style={StyleSheet.absoluteFill}
//             blurType="dark"
//             blurAmount={20}
//             reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
//           />
//           <Animatable.View
//             animation="slideInUp"
//             duration={300}
//             style={[
//               styles.modalContent,
//               {
//                 width: '90%',
//                 maxWidth: 340,
//                 paddingVertical: 20,
//               },
//             ]}>
//             <Text
//               style={{
//                 fontSize: 18,
//                 fontWeight: '700',
//                 color: theme.colors.foreground,
//                 marginBottom: 20,
//                 textAlign: 'center',
//               }}>
//               Share Outfit
//             </Text>

//             {/* Share to Community */}
//             <AppleTouchFeedback
//               hapticStyle="impactMedium"
//               onPress={handleShareToCommunity}
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: theme.colors.button1,
//                 paddingVertical: 14,
//                 paddingHorizontal: 20,
//                 borderRadius: 14,
//                 marginBottom: 12,
//               }}>
//               <MaterialIcons
//                 name="groups"
//                 size={24}
//                 color={theme.colors.buttonText1}
//               />
//               <Text
//                 style={{
//                   color: theme.colors.buttonText1,
//                   fontSize: 16,
//                   fontWeight: '600',
//                   marginLeft: 12,
//                 }}>
//                 Share to Community
//               </Text>
//             </AppleTouchFeedback>

//             {/* Share Externally */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={handleShareExternal}
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: theme.colors.surface2,
//                 paddingVertical: 14,
//                 paddingHorizontal: 20,
//                 marginBottom: 12,
//                 borderRadius: 14,
//                 borderWidth: tokens.borderWidth.md,
//                 borderColor: theme.colors.muted,
//               }}>
//               <MaterialIcons
//                 name="ios-share"
//                 size={24}
//                 color={theme.colors.foreground}
//               />
//               <Text
//                 style={{
//                   color: theme.colors.foreground,
//                   fontSize: 16,
//                   fontWeight: '600',
//                   marginLeft: 12,
//                 }}>
//                 Share via...
//               </Text>
//             </AppleTouchFeedback>

//             {/* Cancel */}
//             <AppleTouchFeedback
//               hapticStyle="selection"
//               onPress={() => {
//                 setShareOptionsVisible(false);
//                 setPendingShareOutfit(null);
//               }}
//               style={{
//                 paddingVertical: 12,
//                 alignItems: 'center',
//                 borderRadius: 14,
//                 borderWidth: tokens.borderWidth.md,
//                 borderColor: theme.colors.muted,
//               }}>
//               <Text
//                 style={{
//                   color: theme.colors.muted,
//                   fontSize: 16,
//                 }}>
//                 Cancel
//               </Text>
//             </AppleTouchFeedback>
//           </Animatable.View>
//         </Pressable>
//       </Modal>

//       {/* 🌐 Community Share Modal */}
//       <Modal
//         visible={communityShareModalVisible}
//         transparent
//         animationType="fade"
//         onRequestClose={() => setCommunityShareModalVisible(false)}>
//         <Pressable
//           style={styles.modalContainer}
//           onPress={() => setCommunityShareModalVisible(false)}>
//           <BlurView
//             style={StyleSheet.absoluteFill}
//             blurType="dark"
//             blurAmount={20}
//             reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
//           />
//           <Pressable
//             onPress={e => e.stopPropagation()}
//             style={[
//               styles.modalContent,
//               {
//                 width: '90%',
//                 maxWidth: 360,
//                 paddingVertical: 24,
//               },
//             ]}>
//             <Text
//               style={{
//                 fontSize: 18,
//                 fontWeight: '700',
//                 color: theme.colors.foreground,
//                 marginBottom: 20,
//                 textAlign: 'center',
//               }}>
//               Share to Community
//             </Text>

//             {/* Description Input */}
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 8,
//               }}>
//               Description
//             </Text>
//             <TextInput
//               value={communityDescription}
//               onChangeText={setCommunityDescription}
//               placeholder={
//                 pendingShareOutfit?.name || 'Describe your outfit...'
//               }
//               placeholderTextColor={theme.colors.muted}
//               multiline
//               style={{
//                 backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                 borderRadius: 12,
//                 padding: 14,
//                 color: theme.colors.foreground,
//                 fontSize: 15,
//                 minHeight: 80,
//                 marginBottom: 16,
//                 textAlignVertical: 'top',
//               }}
//             />

//             {/* Tags Input */}
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 8,
//               }}>
//               Tags (comma-separated)
//             </Text>
//             <TextInput
//               value={communityTags}
//               onChangeText={setCommunityTags}
//               placeholder="casual, summer, streetwear..."
//               placeholderTextColor={theme.colors.muted}
//               style={{
//                 backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                 borderRadius: 12,
//                 padding: 14,
//                 color: theme.colors.foreground,
//                 fontSize: 15,
//                 marginBottom: 24,
//               }}
//             />

//             {/* Action Buttons */}
//             <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
//               <AppleTouchFeedback
//                 hapticStyle="selection"
//                 onPress={() => {
//                   setCommunityShareModalVisible(false);
//                   setPendingShareOutfit(null);
//                 }}
//                 style={{paddingHorizontal: 20, paddingVertical: 12}}>
//                 <Text style={{color: theme.colors.muted, fontSize: 16}}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>

//               <AppleTouchFeedback
//                 hapticStyle="impactMedium"
//                 onPress={handleConfirmCommunityShare}
//                 style={{
//                   backgroundColor: theme.colors.button1,
//                   paddingHorizontal: 24,
//                   paddingVertical: 12,
//                   borderRadius: 12,
//                   marginLeft: 12,
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.buttonText1,
//                     fontSize: 16,
//                     fontWeight: '600',
//                   }}>
//                   {createPostMutation.isPending ? 'Sharing...' : 'Share'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Pressable>
//         </Pressable>
//       </Modal>

//       {/* 🖼 Full-Screen Outfit Modal — matches AI Stylist detail view */}
//       <Modal
//         visible={!!fullScreenOutfit}
//         transparent
//         animationType="fade"
//         onRequestClose={() => setFullScreenOutfit(null)}>
//         <View
//           style={{
//             flex: 1,
//             backgroundColor: 'rgba(0,0,0,0.92)',
//           }}>
//           {/* Close button */}
//           <TouchableOpacity
//             onPress={() => setFullScreenOutfit(null)}
//             style={{
//               position: 'absolute',
//               top: 60,
//               right: 20,
//               zIndex: 10,
//               padding: 10,
//             }}>
//             <MaterialIcons name="close" size={32} color="#fff" />
//           </TouchableOpacity>

//           <ScrollView
//             contentContainerStyle={{
//               alignItems: 'center',
//               paddingTop: 100,
//               paddingBottom: 40,
//             }}
//             showsVerticalScrollIndicator={false}>
//           {(() => {
//             if (!fullScreenOutfit) return null;
//             const topItem = fullScreenOutfit.top;
//             const bottomItem = fullScreenOutfit.bottom;
//             const shoesItem = fullScreenOutfit.shoes;
//             const knownIds = new Set(
//               [topItem?.id, bottomItem?.id, shoesItem?.id].filter(Boolean),
//             );
//             const extraItems = (fullScreenOutfit.allItems || []).filter(
//               i => !knownIds.has(i.id),
//             );
//             const allItems =
//               fullScreenOutfit.allItems ||
//               [topItem, bottomItem, shoesItem].filter(Boolean);
//             const screenWidth = Dimensions.get('window').width;

//             return (
//               <View style={{alignItems: 'center', width: '100%'}}>
//                 {/* Outfit Title */}
//                 <Text style={{color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 16, paddingHorizontal: 32}} numberOfLines={1}>
//                   {fullScreenOutfit.name || 'Outfit'}
//                 </Text>

//                 {/* Outfit Card — composite layout */}
//                 <View
//                   style={{
//                     width: screenWidth - 16,
//                     borderRadius: 24,
//                     backgroundColor: theme.colors.surface,
//                     flexDirection: 'row',
//                     paddingVertical: 12,
//                     alignItems: 'center',
//                     justifyContent: 'center',
//                   }}>
//                   {/* Left column: first extra item (outerwear) */}
//                   <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8}}>
//                     {extraItems.length > 0 && extraItems[0]?.image && (
//                       <Image
//                         source={{uri: extraItems[0].image}}
//                         style={{width: 80, height: 130}}
//                         resizeMode="contain"
//                       />
//                     )}
//                   </View>

//                   {/* Center column: Top → Bottom → Shoes (overlapping) */}
//                   <View style={{flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 6}}>
//                     {topItem?.image && (
//                       <Image
//                         source={{uri: topItem.image}}
//                         style={{width: 200, height: 190, zIndex: 3}}
//                         resizeMode="contain"
//                       />
//                     )}
//                     {bottomItem?.image && (
//                       <Image
//                         source={{uri: bottomItem.image}}
//                         style={{width: 200, height: 220, marginTop: -42, zIndex: 2}}
//                         resizeMode="contain"
//                       />
//                     )}
//                     {shoesItem?.image && (
//                       <Image
//                         source={{uri: shoesItem.image}}
//                         style={{width: 160, height: 145, marginTop: -32, zIndex: 1}}
//                         resizeMode="contain"
//                       />
//                     )}
//                   </View>

//                   {/* Right column: remaining extras (accessories) */}
//                   <View style={{width: 85, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 8, gap: 10}}>
//                     {extraItems.slice(1).map((acc, idx) =>
//                       acc?.image ? (
//                         <Image
//                           key={acc.id || idx}
//                           source={{uri: acc.image}}
//                           style={{width: 80, height: 80}}
//                           resizeMode="contain"
//                         />
//                       ) : null,
//                     )}
//                   </View>
//                 </View>

//                 {/* Individual Items Grid */}
//                 <View style={{
//                   width: screenWidth - 32,
//                   marginTop: 24,
//                 }}>
//                   <Text style={{color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 12, opacity: 0.7}}>
//                     Items in this outfit
//                   </Text>
//                   <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 10}}>
//                     {allItems.map((item, idx) => (
//                       <View
//                         key={item.id || idx}
//                         style={{
//                           width: (screenWidth - 52) / 2,
//                           height: (screenWidth - 52) / 2,
//                           borderRadius: 12,
//                           overflow: 'hidden',
//                           backgroundColor: theme.colors.surface,
//                         }}>
//                         <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', padding: 10}}>
//                           <Image
//                             source={{uri: item.image}}
//                             style={{width: 150, height: 150}}
//                             resizeMode="contain"
//                           />
//                         </View>
//                         <View style={{paddingHorizontal: 8, paddingBottom: 8}}>
//                           <Text
//                             style={{color: theme.colors.foreground, fontSize: 11, textAlign: 'center'}}
//                             numberOfLines={1}>
//                             {item.name}
//                           </Text>
//                         </View>
//                       </View>
//                     ))}
//                   </View>
//                 </View>

//                 {/* Notes */}
//                 {fullScreenOutfit.notes?.trim() && (
//                   <Text
//                     style={{
//                       color: '#fff',
//                       fontSize: 14,
//                       fontWeight: '400',
//                       textAlign: 'center',
//                       marginTop: 20,
//                       paddingHorizontal: 24,
//                       opacity: 0.85,
//                       lineHeight: 20,
//                     }}>
//                     {fullScreenOutfit.notes.trim()}
//                   </Text>
//                 )}

//                 {/* Tags */}
//                 {fullScreenOutfit.tags?.length ? (
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       flexWrap: 'wrap',
//                       justifyContent: 'center',
//                       marginTop: 24,
//                     }}>
//                     {fullScreenOutfit.tags.map(tag => (
//                       <View
//                         key={tag}
//                         style={{
//                           backgroundColor: 'rgba(255,255,255,0.1)',
//                           borderRadius: 20,
//                           paddingHorizontal: 14,
//                           paddingVertical: 6,
//                           margin: 6,
//                         }}>
//                         <Text
//                           style={{
//                             color: '#fff',
//                             fontSize: 14,
//                             fontWeight: '600',
//                             letterSpacing: 0.2,
//                           }}>
//                           #{tag}
//                         </Text>
//                       </View>
//                     ))}
//                   </View>
//                 ) : null}

//               </View>
//             );
//           })()}
//           </ScrollView>
//         </View>
//       </Modal>

//       {/* Scroll-to-top button */}
//       <AppleTouchFeedback
//         onPress={() => {
//           flashListRef.current?.scrollToOffset({offset: 0, animated: true});
//         }}
//         style={{
//           position: 'absolute',
//           bottom: 100,
//           right: 20,
//           width: 48,
//           height: 48,
//           borderRadius: 24,
//           backgroundColor: 'rgba(0,0,0,0.6)',
//           borderColor: theme.colors.muted,
//           borderWidth: tokens.borderWidth.md,
//           alignItems: 'center',
//           justifyContent: 'center',
//           shadowColor: '#000',
//           shadowOpacity: 0.3,
//           shadowRadius: 8,
//           shadowOffset: {width: 0, height: 4},
//         }}>
//         <MaterialIcons name="keyboard-arrow-up" size={32} color="#fff" />
//       </AppleTouchFeedback>

//       {/* Sort / Filter Popover (matches ClosetScreen pattern) */}
//       {menuVisible && (
//         <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
//           <View
//             style={{
//               position: 'absolute',
//               top: 20,
//               left: 0,
//               right: 0,
//               bottom: 0,
//               backgroundColor: 'transparent',
//               zIndex: 9999,
//             }}>
//             <TouchableWithoutFeedback>
//               <View>
//                 {menuView === 'main' && (
//                   <View
//                     style={{
//                       position: 'absolute',
//                       top: insets.top + 85,
//                       right: 20,
//                       width: 220,
//                       backgroundColor: theme.colors.surface,
//                       borderRadius: 16,
//                       paddingVertical: 12,
//                       paddingHorizontal: 14,
//                       elevation: 20,
//                       shadowColor: '#000',
//                       shadowOpacity: 0.25,
//                       shadowOffset: {width: 0, height: 4},
//                       shadowRadius: 14,
//                       zIndex: 9999,
//                     }}>
//                          <TouchableOpacity
//                       style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}
//                       onPress={() => {
//                         hSelect();
//                         openSubmenu('filter');
//                       }}>
//                       <MaterialIcons name="filter-list" size={22} color={theme.colors.foreground} />
//                       <Text style={{fontSize: 17, color: theme.colors.foreground, fontWeight: '600', marginLeft: 10}}>
//                         Filter by Occasion
//                       </Text>
//                     </TouchableOpacity>
//                     <TouchableOpacity
//                       style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}
//                       onPress={() => {
//                         hSelect();
//                         openSubmenu('sort');
//                       }}>
//                       <MaterialIcons name="sort" size={22} color={theme.colors.foreground} />
//                       <Text style={{fontSize: 17, color: theme.colors.foreground, fontWeight: '600', marginLeft: 10}}>
//                         Sort
//                       </Text>
//                     </TouchableOpacity>
                 
//                   </View>
//                 )}

//                 {menuView === 'sort' && (
//                   <Animated.View
//                     style={{
//                       position: 'absolute',
//                       top: insets.top + 85,
//                       right: 16,
//                       width: 260,
//                       backgroundColor: theme.colors.surface,
//                       borderRadius: 16,
//                       paddingVertical: 12,
//                       paddingHorizontal: 14,
//                       elevation: 20,
//                       shadowColor: '#000',
//                       shadowOpacity: 0.25,
//                       shadowOffset: {width: 0, height: 4},
//                       shadowRadius: 14,
//                       zIndex: 9999,
//                       opacity: submenuOpacity,
//                       transform: [{scale: submenuOpacity.interpolate({inputRange: [0, 1], outputRange: [0.95, 1]})}],
//                     }}>
//                     {(
//                       [
//                         {key: 'newest', label: 'Newest', icon: 'schedule'},
//                         {key: 'favorites', label: 'Favorites', icon: 'favorite'},
//                         {key: 'planned', label: 'Planned', icon: 'event'},
//                         {key: 'stars', label: 'Rating', icon: 'star'},
//                       ] as const
//                     ).map(({key, label, icon}) => (
//                       <TouchableOpacity
//                         key={key}
//                         onPress={() => {
//                           hSelect();
//                           setSortType(key);
//                           setMenuVisible(false);
//                         }}
//                         style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
//                         <MaterialIcons
//                           name={icon}
//                           size={20}
//                           color={sortType === key ? theme.colors.primary : theme.colors.foreground}
//                         />
//                         <Text
//                           style={{
//                             fontSize: 16,
//                             color: sortType === key ? theme.colors.primary : theme.colors.foreground,
//                             fontWeight: sortType === key ? '700' : '400',
//                             marginLeft: 10,
//                             flex: 1,
//                           }}>
//                           {label}
//                         </Text>
//                         {sortType === key && (
//                           <MaterialIcons name="check" size={18} color={theme.colors.primary} />
//                         )}
//                       </TouchableOpacity>
//                     ))}
//                   </Animated.View>
//                 )}

//                 {menuView === 'filter' && (
//                   <Animated.View
//                     style={{
//                       position: 'absolute',
//                       top: insets.top + 85,
//                       right: 16,
//                       width: 280,
//                       maxHeight: Dimensions.get('window').height * 0.6,
//                       backgroundColor: theme.colors.surface,
//                       borderRadius: 16,
//                       paddingVertical: 12,
//                       paddingHorizontal: 14,
//                       elevation: 20,
//                       shadowColor: '#000',
//                       shadowOpacity: 0.25,
//                       shadowOffset: {width: 0, height: 4},
//                       shadowRadius: 14,
//                       zIndex: 9999,
//                       opacity: submenuOpacity,
//                       transform: [{scale: submenuOpacity.interpolate({inputRange: [0, 1], outputRange: [0.95, 1]})}],
//                     }}>
//                     <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom: 8}}>
//                       {/* "All" option */}
//                       <TouchableOpacity
//                         onPress={() => {
//                           hSelect();
//                           setOccasionFilter(null);
//                           setMenuVisible(false);
//                         }}
//                         style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
//                         <MaterialIcons
//                           name="select-all"
//                           size={20}
//                           color={occasionFilter === null ? theme.colors.primary : theme.colors.foreground}
//                         />
//                         <Text
//                           style={{
//                             fontSize: 16,
//                             color: occasionFilter === null ? theme.colors.primary : theme.colors.foreground,
//                             fontWeight: occasionFilter === null ? '700' : '400',
//                             marginLeft: 10,
//                             flex: 1,
//                           }}>
//                           All ({displayOutfits.length})
//                         </Text>
//                         {occasionFilter === null && (
//                           <MaterialIcons name="check" size={18} color={theme.colors.primary} />
//                         )}
//                       </TouchableOpacity>

//                       {/* Occasion options */}
//                       {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(occasion => {
//                         const config = OCCASION_CONFIG[occasion];
//                         const count = displayOutfits.filter(o => o.occasion === occasion).length;
//                         if (count === 0) return null;
//                         const isSelected = occasionFilter === occasion;

//                         return (
//                           <TouchableOpacity
//                             key={occasion}
//                             onPress={() => {
//                               hSelect();
//                               setOccasionFilter(isSelected ? null : occasion);
//                               setMenuVisible(false);
//                             }}
//                             style={{paddingVertical: 10, flexDirection: 'row', alignItems: 'center'}}>
//                             <MaterialIcons
//                               name={config.icon as any}
//                               size={20}
//                               color={isSelected ? config.color : theme.colors.foreground}
//                             />
//                             <Text
//                               style={{
//                                 fontSize: 16,
//                                 color: isSelected ? config.color : theme.colors.foreground,
//                                 fontWeight: isSelected ? '700' : '400',
//                                 marginLeft: 10,
//                                 flex: 1,
//                               }}>
//                               {config.label} ({count})
//                             </Text>
//                             {isSelected && (
//                               <MaterialIcons name="check" size={18} color={config.color} />
//                             )}
//                           </TouchableOpacity>
//                         );
//                       })}
//                     </ScrollView>
//                   </Animated.View>
//                 )}
//               </View>
//             </TouchableWithoutFeedback>
//           </View>
//         </TouchableWithoutFeedback>
//       )}
//     </SafeAreaView>
//   );
// }


///////////////////

// import React, {useEffect, useRef, useState, useCallback, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   TouchableOpacity,
//   Alert,
//   TextInput,
//   Modal,
//   Dimensions,
//   Platform,
//   Animated,
//   Easing,
//   ScrollView,
//   PanResponder,
//   Pressable,
// } from 'react-native';
// import {FlashList} from '@shopify/flash-list';
// import FastImage from 'react-native-fast-image';
// import {BlurView} from '@react-native-community/blur';
// import * as Animatable from 'react-native-animatable';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import DateTimePicker from '@react-native-community/datetimepicker';
// import ViewShot from 'react-native-view-shot';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import PushNotification from 'react-native-push-notification';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// import {useAppTheme} from '../context/ThemeContext';
// import {useFavorites} from '../hooks/useFavorites';
// import {useUUID} from '../context/UUIDContext';
// import {
//   useOutfitsQuery,
//   useUpdateOutfit,
//   useDeleteOutfit,
//   useScheduleOutfit,
//   useCancelScheduledOutfit,
//   useMarkOutfitWorn,
//   useUnmarkOutfitWorn,
//   useInvalidateSavedOutfits,
//   SavedOutfitData,
// } from '../hooks/useOutfitsData';
// import {useUserProfile} from '../hooks/useHomeData';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {addOutfitToCalendar, removeCalendarEvent} from '../utils/calendar';
// import {addToInbox} from '../utils/notificationInbox';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import SwipeableCard from '../components/SwipeableCard/SwipeableCard';
// import {Share} from 'react-native';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {useCreatePost} from '../hooks/useCommunityApi';
// import {globalNavigate} from '../MainApp';

// const {width: SCREEN_WIDTH} = Dimensions.get('window');
// const CARD_WIDTH = SCREEN_WIDTH - 32;
// const ESTIMATED_CARD_HEIGHT = 320;

// // Animated pressable with scale effect for images
// const ScalePressable = ({
//   children,
//   onPress,
//   style,
// }: {
//   children: React.ReactNode;
//   onPress: () => void;
//   style?: any;
// }) => {
//   const scaleAnim = useRef(new Animated.Value(1)).current;

//   const handlePressIn = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 0.97,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   const handlePressOut = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 1,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   return (
//     <Pressable
//       onPress={onPress}
//       onPressIn={handlePressIn}
//       onPressOut={handlePressOut}>
//       <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
//         {children}
//       </Animated.View>
//     </Pressable>
//   );
// };

// // Occasion types with color coding
// type OutfitOccasion =
//   | 'Work'
//   | 'DateNight'
//   | 'Casual'
//   | 'Formal'
//   | 'Travel'
//   | 'Gym'
//   | 'Weekend'
//   | 'Party'
//   | 'Interview'
//   | 'Brunch';

// // Occasion → Color & Icon mapping
// const OCCASION_CONFIG: Record<
//   OutfitOccasion,
//   {color: string; icon: string; label: string}
// > = {
//   Work: {color: '#3B82F6', icon: 'work', label: 'Work'},
//   DateNight: {color: '#EC4899', icon: 'favorite', label: 'Date Night'},
//   Casual: {color: '#22C55E', icon: 'weekend', label: 'Casual'},
//   Formal: {color: '#F59E0B', icon: 'star', label: 'Formal'},
//   Travel: {color: '#14B8A6', icon: 'flight', label: 'Travel'},
//   Gym: {color: '#F97316', icon: 'fitness-center', label: 'Gym'},
//   Weekend: {color: '#8B5CF6', icon: 'wb-sunny', label: 'Weekend'},
//   Party: {color: '#EF4444', icon: 'celebration', label: 'Party'},
//   Interview: {color: '#6366F1', icon: 'business-center', label: 'Interview'},
//   Brunch: {color: '#F472B6', icon: 'brunch-dining', label: 'Brunch'},
// };

// // Use SavedOutfitData from useOutfitsData hook
// type SavedOutfit = SavedOutfitData;

// const CLOSET_KEY = 'savedOutfits';
// const FAVORITES_KEY = 'favoriteOutfits';
// const SHEET_MAX_H = Math.min(Dimensions.get('window').height * 0.2, 560);

// export default function SavedOutfitsScreen() {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const insets = useSafeAreaInsets();
//   const [profilePicture, setProfilePicture] = useState<string>('');

//   // TanStack Query: Fetch user profile for name
//   const {data: userProfile} = useUserProfile(userId || '');
//   const userName =
//     `${userProfile?.first_name || ''}${userProfile?.last_name || ''}`.trim() ||
//     'StylHelpr';

//   // Load profile picture from AsyncStorage
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(`profile_picture:${userId}`);
//       if (cached) {
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   if (!userId) return null;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },

//     // 🪩 Core Outfit Card
//     card: {
//       backgroundColor: 'red',
//       borderRadius: 24,
//       padding: 18,
//       marginBottom: 6,
//       borderWidth: tokens.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowRadius: 22,
//       shadowOffset: {width: 0, height: 10},
//       transform: [{scale: 0.98}],
//       elevation: 12,
//     },

//     timestamp: {
//       fontSize: 12,
//       color: theme.colors.foreground3,
//       marginTop: 4,
//       marginBottom: 4,
//       fontWeight: '500',
//       letterSpacing: 0.2,
//     },

//     actions: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },

//     imageRow: {
//       flexDirection: 'row',
//       justifyContent: 'flex-start',
//       // marginTop: 12,
//       gap: 12,
//     },

//     notes: {
//       marginTop: 12,
//       fontStyle: 'italic',
//       color: theme.colors.foreground3,
//       fontSize: 14,
//       lineHeight: 20,
//     },

//     stars: {
//       flexDirection: 'row',
//       marginTop: 6,
//     },

//     // 🌫️ Overlay for blur modals / pickers
//     overlay: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'center',
//       alignItems: 'center',
//       backgroundColor: 'rgba(0,0,0,0.3)',
//     },

//     // 📦 Centered modal container
//     modalContainer: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },

//     // ✏️ Edit Name / Delete Confirmation Modal
//     modalContent: {
//       backgroundColor: theme.colors.surface,
//       padding: 22,
//       borderRadius: 20,
//       width: '100%',
//       maxWidth: 400,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 28,
//       shadowOffset: {width: 0, height: 14},
//       elevation: 20,
//       transform: [{scale: 1}],
//     },

//     input: {
//       marginTop: 12,
//       borderBottomWidth: 1,
//       borderBottomColor: theme.colors.muted,
//       paddingVertical: 8,
//       color: theme.colors.foreground,
//       fontSize: 16,
//     },

//     modalActions: {
//       flexDirection: 'row',
//       justifyContent: 'flex-end',
//       marginTop: 20,
//       gap: 20,
//     },

//     // 🪟 Full-screen Outfit Viewer
//     fullModalContainer: {
//       ...StyleSheet.absoluteFill,
//       justifyContent: 'flex-start',
//       alignItems: 'center',
//       paddingTop: 72,
//       paddingHorizontal: 124,
//     },

//     fullImage: {
//       width: '70%',
//       aspectRatio: 1,
//       marginVertical: 16,
//       borderRadius: 18,
//       backgroundColor: theme.colors.background,
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 24,
//       shadowOffset: {width: 0, height: 16},
//       elevation: 18,
//     },

//     // 📅 Bottom Sheet
//     sheetContainer: {
//       width: '90%',
//       backgroundColor: theme.colors.surface3,
//       borderRadius: 30,
//       paddingTop: 12,
//       paddingBottom: Platform.OS === 'ios' ? 16 : 16,
//       paddingHorizontal: 20,
//       // maxHeight: SHEET_MAX_H,
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 32,
//       shadowOffset: {width: 0, height: -14},
//       elevation: 26,
//     },

//     grabber: {
//       alignSelf: 'center',
//       width: 50,
//       height: 6,
//       borderRadius: 3,
//       backgroundColor: 'rgba(255,255,255,0.25)',
//       marginBottom: 12,
//     },

//     sheetHeaderRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'space-between',
//       marginBottom: 12,
//       paddingHorizontal: 4,
//     },

//     sheetTitle: {
//       fontSize: 18,
//       fontWeight: '800',
//       color: theme.colors.foreground,
//       letterSpacing: 0.3,
//     },

//     sheetPill: {
//       paddingHorizontal: 16,
//       paddingVertical: 10,
//       borderRadius: 22,
//       backgroundColor: theme.colors.input2 ?? 'rgba(43,43,43,1)',
//     },

//     sheetPillText: {
//       color: theme.colors.foreground3 ?? '#EAEAEA',
//       fontWeight: '700',
//       letterSpacing: 0.2,
//     },

//     sheetFooterRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       paddingHorizontal: 6,
//       marginTop: 14,
//       marginBottom: 10,
//     },

//     // 🍞 Toast
//     toast: {
//       position: 'absolute',
//       bottom: 30,
//       left: 20,
//       right: 20,
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 14,
//       paddingHorizontal: 18,
//       borderRadius: 16,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 20,
//       shadowOffset: {width: 0, height: 10},
//       elevation: 20,
//     },
//   });

//   // 🧠 State Management
//   const [editingOutfitId, setEditingOutfitId] = useState<string | null>(null);
//   const [editedName, setEditedName] = useState('');
//   const [editedOccasion, setEditedOccasion] = useState<
//     OutfitOccasion | undefined
//   >(undefined);

//   // Demo outfit state - tracks if user has ever had real saved outfits
//   const [hasEverHadOutfits, setHasEverHadOutfits] = useState<boolean | null>(
//     null,
//   );

//   // Demo outfit items (using bundled wardrobe assets)
//   const demoOutfits: SavedOutfit[] = [
//     {
//       id: 'demo-outfit-1',
//       name: 'Upscale Style 1',
//       type: 'custom',
//       top: {
//         id: 'demo-top',
//         name: 'Cable Knit Sweater',
//         image: Image.resolveAssetSource(
//           require('../assets/images/top-sweater1.png'),
//         ).uri,
//       },
//       bottom: {
//         id: 'demo-bottom',
//         name: 'Classic Blue Jeans',
//         image: Image.resolveAssetSource(
//           require('../assets/images/bottoms-jeans1.png'),
//         ).uri,
//       },
//       shoes: {
//         id: 'demo-shoes',
//         name: 'Black Leather Loafers',
//         image: Image.resolveAssetSource(
//           require('../assets/images/shoes-loafers1.jpg'),
//         ).uri,
//       },
//       createdAt: new Date().toISOString(),
//       occasion: 'DateNight',
//       favorited: true,
//       tags: [],
//     },
//   ];

//   // Load hasEverHadOutfits flag from AsyncStorage
//   useEffect(() => {
//     const loadDemoFlag = async () => {
//       try {
//         const hasOutfits = await AsyncStorage.getItem('saved_outfits_has_real');
//         setHasEverHadOutfits(hasOutfits === 'true');
//       } catch (err) {
//         console.error('Failed to load saved outfits demo flag:', err);
//         setHasEverHadOutfits(false);
//       }
//     };
//     loadDemoFlag();
//   }, []);

//   // Occasion filter state (null = "All")
//   const [occasionFilter, setOccasionFilter] = useState<OutfitOccasion | null>(
//     null,
//   );

//   const [planningOutfitId, setPlanningOutfitId] = useState<string | null>(null);
//   const [showDatePicker, setShowDatePicker] = useState(false);
//   const [showTimePicker, setShowTimePicker] = useState(false);
//   const [selectedTempDate, setSelectedTempDate] = useState<Date | null>(null);
//   const [selectedTempTime, setSelectedTempTime] = useState<Date | null>(null);
//   const [lastDeletedOutfit, setLastDeletedOutfit] =
//     useState<SavedOutfit | null>(null);

//   const {
//     favorites,
//     isLoading: favoritesLoading,
//     toggleFavorite,
//   } = useFavorites(userId);

//   // TanStack Query: Fetch outfits with caching
//   const {
//     data: combinedOutfits = [],
//     isLoading: outfitsLoading,
//     refetch: refetchOutfits,
//   } = useOutfitsQuery(userId, favorites);

//   // Update hasEverHadOutfits when real content appears
//   useEffect(() => {
//     if (
//       combinedOutfits &&
//       combinedOutfits.length > 0 &&
//       hasEverHadOutfits === false
//     ) {
//       setHasEverHadOutfits(true);
//       AsyncStorage.setItem('saved_outfits_has_real', 'true');
//     }
//   }, [combinedOutfits, hasEverHadOutfits]);

//   // Compute outfits state: 'demo' | 'real' | 'empty-real'
//   const outfitsState =
//     combinedOutfits && combinedOutfits.length > 0
//       ? 'real'
//       : hasEverHadOutfits
//         ? 'empty-real'
//         : 'demo';

//   // Use demo outfits when in demo state, otherwise use real outfits
//   const displayOutfits =
//     outfitsState === 'demo' ? demoOutfits : combinedOutfits;

//   console.log('🎨 SavedOutfits render:', {
//     outfitsState,
//     combinedOutfitsCount: combinedOutfits?.length,
//     displayOutfitsCount: displayOutfits?.length,
//     hasEverHadOutfits,
//   });

//   // TanStack Query: Mutations
//   const updateOutfitMutation = useUpdateOutfit();
//   const deleteOutfitMutation = useDeleteOutfit();
//   const scheduleOutfitMutation = useScheduleOutfit();
//   const cancelScheduledOutfitMutation = useCancelScheduledOutfit();
//   const markWornMutation = useMarkOutfitWorn();
//   const unmarkWornMutation = useUnmarkOutfitWorn();
//   const invalidateSavedOutfits = useInvalidateSavedOutfits();

//   const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
//   const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

//   const datePickerRef = useRef<Animatable.View & View>(null);

//   const viewRefs = useRef<{[key: string]: ViewShot | null}>({});
//   const [fullScreenOutfit, setFullScreenOutfit] = useState<SavedOutfit | null>(
//     null,
//   );
//   const displayedOutfitRef = useRef<SavedOutfit | null>(null);

//   // FlashList ref for scroll-to-top
//   const flashListRef = useRef<any>(null);

//   const screenH = Dimensions.get('window').height;
//   const translateY = useRef(new Animated.Value(screenH)).current;

//   useEffect(() => {
//     if (fullScreenOutfit) {
//       // 🟢 Animate up from offscreen only when opening
//       Animated.timing(translateY, {
//         toValue: 0,
//         duration: 300,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }).start();
//     }
//   }, [fullScreenOutfit]);

//   const handleClose = useCallback(() => {
//     // 🧠 just trigger the modal to close
//     setFullScreenOutfit(null);
//   }, []);

//   const panResponder = useRef(
//     PanResponder.create({
//       onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 8,
//       onPanResponderMove: (_e, g) => {
//         if (g.dy > 0) translateY.setValue(g.dy);
//       },
//       onPanResponderRelease: (_e, g) => {
//         if (g.dy > 100 || g.vy > 0.3) {
//           handleClose();
//         } else {
//           Animated.spring(translateY, {
//             toValue: 0,
//             useNativeDriver: true,
//           }).start();
//         }
//       },
//     }),
//   ).current;

//   const hSelect = () =>
//     ReactNativeHapticFeedback.trigger('selection', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   // ⏱️ Utility: Combine date + time
//   const combineDateAndTime = (date: Date, time: Date) => {
//     const d = new Date(date);
//     const t = new Date(time);
//     d.setHours(t.getHours(), t.getMinutes(), 0, 0);
//     return d;
//   };

//   // Ref for the share composite ViewShot
//   const shareCompositeRef = useRef<ViewShot>(null);
//   const [shareOutfit, setShareOutfit] = useState<SavedOutfit | null>(null);
//   const [shareOptionsVisible, setShareOptionsVisible] = useState(false);
//   const [pendingShareOutfit, setPendingShareOutfit] =
//     useState<SavedOutfit | null>(null);
//   const [communityShareModalVisible, setCommunityShareModalVisible] =
//     useState(false);
//   const [communityDescription, setCommunityDescription] = useState('');
//   const [communityTags, setCommunityTags] = useState('');

//   // Community post mutation
//   const createPostMutation = useCreatePost();

//   // Show share options when user taps share button
//   const handleSharePress = (outfit: SavedOutfit) => {
//     ReactNativeHapticFeedback.trigger('impactLight', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });
//     setPendingShareOutfit(outfit);
//     setShareOptionsVisible(true);
//   };

//   // Share to Community
//   const handleShareToCommunity = async () => {
//     if (!pendingShareOutfit || !userId) return;

//     setShareOptionsVisible(false);
//     setCommunityDescription('');
//     setCommunityTags('');
//     setCommunityShareModalVisible(true);
//   };

//   const handleConfirmCommunityShare = async () => {
//     if (!pendingShareOutfit || !userId) return;

//     try {
//       ReactNativeHapticFeedback.trigger('impactMedium', {
//         enableVibrateFallback: true,
//         ignoreAndroidSystemSettings: false,
//       });

//       const tagsArray = communityTags
//         .split(',')
//         .map(t => t.trim().toLowerCase())
//         .filter(t => t.length > 0);

//       const outfitName =
//         communityDescription || pendingShareOutfit.name || 'My outfit';
//       // Note: userId is extracted from JWT token on backend, not sent in body
//       await createPostMutation.mutateAsync({
//         topImage: pendingShareOutfit.top?.image,
//         bottomImage: pendingShareOutfit.bottom?.image,
//         shoesImage: pendingShareOutfit.shoes?.image,
//         name: outfitName,
//         description: '',
//         tags: tagsArray.length > 0 ? tagsArray : ['outfit'],
//       });

//       setCommunityShareModalVisible(false);
//       setPendingShareOutfit(null);
//       Alert.alert('Success', 'Your outfit has been shared to the community!');
//     } catch (error) {
//       console.error('Failed to share to community:', error);
//       Alert.alert('Error', 'Failed to share to community. Please try again.');
//     }
//   };

//   // Share externally via native share sheet
//   const handleShareExternal = async () => {
//     setShareOptionsVisible(false);
//     if (pendingShareOutfit) {
//       await handleShareOutfit(pendingShareOutfit);
//       setPendingShareOutfit(null);
//     }
//   };

//   const handleShareOutfit = async (outfit: SavedOutfit) => {
//     try {
//       // ✅ subtle tap
//       ReactNativeHapticFeedback.trigger('impactLight', {
//         enableVibrateFallback: true,
//         ignoreAndroidSystemSettings: false,
//       });

//       // Preload profile picture if available
//       if (profilePicture) {
//         await Image.prefetch(profilePicture);
//       }

//       // Set the outfit to render the composite
//       setShareOutfit(outfit);

//       // Wait for the composite to render
//       await new Promise(resolve => setTimeout(resolve, 300));

//       // Capture the 2x2 grid composite
//       if (!shareCompositeRef.current) {
//         throw new Error('Share composite ref not ready');
//       }

//       const compositeUri = await shareCompositeRef.current.capture?.();

//       // 📨 open native iOS share sheet
//       await Share.share({
//         url: compositeUri,
//         message: `Check out my outfit "${outfit.name || ''}" via StylHelpr`,
//         title: 'Share Your Look',
//       });

//       // Clear the share outfit
//       setShareOutfit(null);
//     } catch (err) {
//       console.error('Error sharing look:', err);
//       setShareOutfit(null);
//     }
//   };

//   const handleNameSave = async () => {
//     if (!editingOutfitId) return;

//     const outfit = combinedOutfits.find(o => o.id === editingOutfitId);
//     if (!outfit) return;

//     // Use TanStack Query mutation (optimistic update handled in hook)
//     updateOutfitMutation.mutate(
//       {
//         userId,
//         outfitId: editingOutfitId,
//         outfitType: outfit.type,
//         name: editedName.trim() || outfit.name,
//         occasion: editedOccasion ?? null,
//       },
//       {
//         onSuccess: () => {
//           // Reset modal state on success
//           setEditingOutfitId(null);
//           setEditedName('');
//           setEditedOccasion(undefined);
//         },
//         onError: err => {
//           console.error('Error updating outfit:', err);
//           Alert.alert('Error', 'Failed to update outfit in the database.');
//         },
//       },
//     );
//   };

//   // ✅ Delete outfit using TanStack Query mutation
//   const handleDelete = (id: string) => {
//     const deleted = combinedOutfits.find(o => o.id === id);
//     if (!deleted) return;

//     // Store for undo toast before optimistic delete
//     setLastDeletedOutfit(deleted);
//     setTimeout(() => setLastDeletedOutfit(null), 3000);

//     deleteOutfitMutation.mutate(
//       {userId, outfitId: id},
//       {
//         onError: err => {
//           console.error('Error deleting outfit:', err);
//           Alert.alert('Error', 'Could not delete outfit from the database.');
//           setLastDeletedOutfit(null);
//         },
//       },
//     );
//   };

//   // 📅 Local notification helpers
//   const scheduleOutfitLocalAlert = async (
//     outfitId: string,
//     outfitName: string | undefined,
//     when: Date,
//   ) => {
//     const title = 'Outfit Reminder';
//     const message = `Wear ${outfitName?.trim() || 'your planned outfit'}`;

//     console.log('🔔 Scheduling notification:', {
//       outfitId,
//       when: when.toISOString(),
//       whenLocal: when.toLocaleString(),
//       now: new Date().toISOString(),
//       nowLocal: new Date().toLocaleString(),
//     });

//     // @ts-ignore - id property exists but types may be outdated
//     PushNotification.localNotificationSchedule({
//       id: `outfit-${outfitId}`,
//       channelId: 'style-channel',
//       title,
//       message,
//       date: when,
//       allowWhileIdle: true,
//       playSound: true,
//       soundName: 'default',
//     });

//     // Also add to notification inbox so it shows in NotificationsScreen
//     await addToInbox(userId, {
//       user_id: userId,
//       id: `outfit-${outfitId}`,
//       title,
//       message,
//       timestamp: when.toISOString(),
//       category: 'outfit',
//       data: {screen: 'Planner'},
//       read: false,
//     });
//   };

//   // 👇 Custom slide-in-from-right animation
//   const slideInFromRight = {
//     from: {opacity: 0, translateX: 80},
//     to: {opacity: 1, translateX: 0},
//   };

//   // 🔄 Reset all scheduling state (Close / Cancel handlers)

//   const resetPlanFlow = async () => {
//     if (datePickerRef.current) {
//       await (datePickerRef.current as any).animate(
//         {
//           from: {opacity: 1, translateY: 0, scale: 1},
//           to: {opacity: 0, translateY: 60, scale: 0.97},
//         },
//         400,
//       );
//     }
//     setPlanningOutfitId(null);
//     setShowDatePicker(false);
//     setShowTimePicker(false);
//     setSelectedTempDate(null);
//     setSelectedTempTime(null);
//   };

//   const commitSchedule = async () => {
//     if (!planningOutfitId || !selectedTempDate || !selectedTempTime) return;
//     try {
//       const selectedOutfit = combinedOutfits.find(
//         o => o.id === planningOutfitId,
//       );
//       if (!selectedOutfit) return;

//       const outfit_type = selectedOutfit.type === 'custom' ? 'custom' : 'ai';
//       const combined = combineDateAndTime(selectedTempDate, selectedTempTime);

//       // clear any previous local alert + calendar event
//       cancelOutfitLocalAlert(planningOutfitId);
//       const oldKey = `outfitCalendar:${planningOutfitId}`;
//       const oldEventId = await AsyncStorage.getItem(oldKey);
//       if (oldEventId) {
//         await removeCalendarEvent(oldEventId);
//         await AsyncStorage.removeItem(oldKey);
//       }

//       // Save to server using TanStack Query mutation (optimistic update in hook)
//       scheduleOutfitMutation.mutate({
//         userId,
//         outfitId: planningOutfitId,
//         outfitType: outfit_type,
//         scheduledFor: combined.toISOString(),
//       });

//       // local notification + add to inbox
//       await scheduleOutfitLocalAlert(
//         planningOutfitId,
//         selectedOutfit.name,
//         combined,
//       );

//       // add to calendar & remember event id
//       const eventId = await addOutfitToCalendar({
//         title: selectedOutfit.name?.trim() || 'Outfit',
//         startISO: combined.toISOString(),
//         notes: selectedOutfit.notes || '',
//         alarmMinutesBefore: 0,
//       });
//       if (eventId) {
//         await AsyncStorage.setItem(
//           `outfitCalendar:${planningOutfitId}`,
//           eventId,
//         );
//       }
//     } catch (err) {
//       console.error('Failed to schedule outfit:', err);
//     } finally {
//       resetPlanFlow();
//     }
//   };

//   const cancelPlannedOutfit = async (outfitId: string) => {
//     // Cancel local alert first
//     cancelOutfitLocalAlert(outfitId);

//     // Remove calendar event (if any)
//     const key = `outfitCalendar:${outfitId}`;
//     const existingId = await AsyncStorage.getItem(key);
//     if (existingId) {
//       await removeCalendarEvent(existingId);
//       await AsyncStorage.removeItem(key);
//     }

//     // Use TanStack Query mutation (optimistic update in hook)
//     cancelScheduledOutfitMutation.mutate(
//       {userId, outfitId},
//       {
//         onError: err => {
//           console.error('Failed to cancel plan:', err);
//           Alert.alert('Error', 'Could not cancel the planned date.');
//         },
//       },
//     );
//   };

//   const cancelOutfitLocalAlert = (outfitId: string) => {
//     // @ts-ignore - cancelLocalNotification exists but types are outdated
//     PushNotification.cancelLocalNotification(`outfit-${outfitId}`);
//   };

//   // Check for schedule changes when component mounts or userId changes
//   // This handles updates made from CalendarPlannerScreen
//   const [lastScheduleCheck, setLastScheduleCheck] = useState<string | null>(
//     null,
//   );
//   useEffect(() => {
//     const checkScheduleChanges = async () => {
//       const changed = await AsyncStorage.getItem('schedulesChanged');
//       if (changed && changed !== lastScheduleCheck) {
//         setLastScheduleCheck(changed);
//         // Invalidate TanStack Query cache to refetch
//         invalidateSavedOutfits(userId);
//       }
//     };
//     checkScheduleChanges();
//     // Also check periodically when screen is visible
//     const interval = setInterval(checkScheduleChanges, 1000);
//     return () => clearInterval(interval);
//   }, [userId, lastScheduleCheck, invalidateSavedOutfits]);

//   // ✨ Sort state and computed outfits
//   const [sortType, setSortType] = useState<
//     'newest' | 'favorites' | 'planned' | 'stars'
//   >('newest');

//   // Filter by occasion first, then sort
//   const sortedOutfits = useMemo(() => {
//     const filteredOutfits = occasionFilter
//       ? displayOutfits.filter(o => o.occasion === occasionFilter)
//       : displayOutfits;

//     return [...filteredOutfits].sort((a, b) => {
//       switch (sortType) {
//         case 'favorites':
//           return Number(b.favorited) - Number(a.favorited);
//         case 'planned':
//           return (
//             new Date(b.plannedDate || 0).getTime() -
//             new Date(a.plannedDate || 0).getTime()
//           );
//         case 'stars':
//           return (b.rating || 0) - (a.rating || 0);
//         default:
//           return (
//             new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
//           );
//       }
//     });
//   }, [displayOutfits, occasionFilter, sortType]);

//   console.log('🎨 sortedOutfits:', {
//     sortedCount: sortedOutfits?.length,
//     occasionFilter,
//     sortType,
//   });

//   // Handle scroll for bottom nav hide/show
//   const handleScroll = useCallback(
//     (event: {nativeEvent: {contentOffset: {y: number}}}) => {
//       if (global.__navScrollY) {
//         global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
//       }
//     },
//     [],
//   );

//   // Share composite card size (matches community grid)
//   const SHARE_SIZE = 400;
//   const SHARE_CELL = SHARE_SIZE / 2;

//   // Memoized render item for FlashList
//   const renderOutfitItem = useCallback(
//     ({item: outfit, index}: {item: SavedOutfit; index: number}) => {
//       const isDemo = outfit.id.startsWith('demo-');

//       // For demo items, render matching the real card layout exactly
//       if (isDemo) {
//         return (
//           <View style={{paddingHorizontal: 6}}>
//             <View style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
//               {/* 🧵 Outfit Header Row */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   justifyContent: 'space-between',
//                   alignItems: 'center',
//                 }}>
//                 <View style={{flex: 1, marginRight: 12}}>
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       gap: 8,
//                     }}>
//                     <Text
//                       style={[
//                         globalStyles.titleBold,
//                         {
//                           fontSize: 20,
//                           color: theme.colors.foreground,
//                         },
//                       ]}>
//                       {outfit.name?.trim() || 'Unnamed Outfit'}
//                     </Text>
//                     <View
//                       style={{
//                         backgroundColor: 'black',
//                         paddingHorizontal: 8,
//                         paddingVertical: 3,
//                         borderRadius: 6,
//                       }}>
//                       <Text
//                         style={{
//                           color: 'white',
//                           fontSize: 11,
//                           fontWeight: tokens.fontWeight.semiBold,
//                         }}>
//                         Sample
//                       </Text>
//                     </View>
//                   </View>

//                   {/* Date info */}
//                   <View style={{marginTop: 6}}>
//                     <Text
//                       style={[
//                         styles.timestamp,
//                         {
//                           fontSize: 13,
//                           fontWeight: '600',
//                           color: theme.colors.foreground2,
//                         },
//                       ]}>
//                       Planned for Oct 5 at 10:14 AM
//                     </Text>
//                     <Text
//                       style={[
//                         styles.timestamp,
//                         {
//                           fontSize: 12,
//                           color: theme.colors.muted,
//                         },
//                       ]}>
//                       Saved Sep 18, 2025
//                     </Text>
//                   </View>
//                 </View>

//                 {/* ✏️ & ❤️ & 📤 Buttons (visual only) */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   {/* ✏️ Edit */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       marginRight: 6,
//                     }}>
//                     <MaterialIcons
//                       name="edit"
//                       size={20}
//                       color={theme.colors.foreground}
//                     />
//                   </View>

//                   {/* ❤️ Favorite */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                     }}>
//                     <MaterialIcons name="favorite" size={20} color="red" />
//                   </View>

//                   {/* 📤 Share */}
//                   <View
//                     style={{
//                       padding: 8,
//                       borderRadius: 14,
//                       backgroundColor:
//                         theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       marginLeft: 6,
//                     }}>
//                     <MaterialIcons
//                       name="ios-share"
//                       size={20}
//                       color={theme.colors.primary}
//                     />
//                   </View>
//                 </View>
//               </View>

//               {/* 👕 Outfit Images - canvas outfits show snapshot + grid, legacy shows row */}
//               <View style={styles.imageRow}>
//                 {outfit.thumbnailUrl ? (
//                   <View style={{flexDirection: 'row', alignItems: 'flex-start'}}>
//                     {/* Left: Canvas snapshot */}
//                     <View style={{
//                       width: 130,
//                       height: 170,
//                       borderRadius: 12,
//                       overflow: 'hidden',
//                       backgroundColor: theme.colors.surface,
//                     }}>
//                       <FastImage
//                         source={{
//                           uri: outfit.thumbnailUrl,
//                           priority: FastImage.priority.normal,
//                           cache: FastImage.cacheControl.web,
//                         }}
//                         style={{
//                           width: 130,
//                           height: 170,
//                           borderRadius: 8,
//                         }}
//                         resizeMode={FastImage.resizeMode.contain}
//                       />
//                     </View>
//                     {/* Right: 4x3 Grid of individual items */}
//                     <View style={{marginLeft: 12, flexDirection: 'row', flexWrap: 'wrap', width: 164, gap: 4}}>
//                       {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((item, index) => {
//                         console.log(`🖼️ Grid item ${item?.id}: ${item?.image?.substring(0, 80)}`);
//                         return item?.image ? (
//                           <FastImage
//                             key={item.id || index}
//                             source={{
//                               uri: item.image,
//                               priority: FastImage.priority.normal,
//                               cache: FastImage.cacheControl.web,
//                             }}
//                             style={{width: 8, height: 38, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.muted}}
//                             resizeMode={FastImage.resizeMode.contain}
//                           />
//                         ) : null;
//                       })}
//                     </View>
//                   </View>
//                 ) : (
//                   (outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
//                     i?.image ? (
//                       <FastImage
//                         key={i.id || idx}
//                         source={{
//                           uri: i.image,
//                           priority: FastImage.priority.normal,
//                           cache: FastImage.cacheControl.web,
//                         }}
//                         style={[
//                           globalStyles.image1,
//                           {
//                             marginRight: 2,
//                             borderRadius: 8,
//                             marginBottom: 8,
//                             marginTop: -6,
//                           },
//                         ]}
//                         resizeMode={FastImage.resizeMode.contain}
//                       />
//                     ) : null,
//                   )
//                 )}
//               </View>

//               {/* Worn count & Occasion chip row */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   alignItems: 'center',
//                 }}>
//                 {/* Left 50% - Worn button & count */}
//                 <View
//                   style={{
//                     flex: 1,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   <View
//                     style={{
//                       paddingVertical: 4.5,
//                       borderRadius: 8,
//                       paddingHorizontal: 12,
//                       backgroundColor:
//                         theme.colors.button1 ?? 'rgba(43,43,43,1)',
//                     }}>
//                     <MaterialIcons
//                       name="checkroom"
//                       size={2}
//                       color={theme.colors.buttonText1}
//                     />
//                   </View>

//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       backgroundColor: theme.colors.surface,
//                       paddingHorizontal: 9,
//                       borderRadius: 12,
//                     }}>
//                     <Text
//                       style={{
//                         fontSize: 16,
//                         fontWeight: '700',
//                         color: theme.colors.foreground,
//                       }}>
//                       Worn:11 x{' '}
//                     </Text>
//                   </View>
//                 </View>

//                 {/* Right 50% - Occasion Chip */}
//                 <View
//                   style={{
//                     flex: 1,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     justifyContent: 'flex-start',
//                   }}>
//                   {outfit.occasion && OCCASION_CONFIG[outfit.occasion] && (
//                     <View
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         backgroundColor: OCCASION_CONFIG[outfit.occasion].color,
//                         paddingHorizontal: 14,
//                         paddingVertical: 9,
//                         borderRadius: 50,
//                       }}>
//                       <MaterialIcons
//                         name={OCCASION_CONFIG[outfit.occasion].icon as any}
//                         size={14}
//                         color={theme.colors.foreground}
//                         style={{marginRight: 5}}
//                       />
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           fontWeight: '600',
//                           color: theme.colors.foreground,
//                         }}>
//                         {OCCASION_CONFIG[outfit.occasion].label}
//                       </Text>
//                     </View>
//                   )}
//                 </View>
//               </View>

//               {/* Schedule & Cancel buttons */}
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   justifyContent: 'flex-start',
//                   flexWrap: 'wrap',
//                   marginTop: 8,
//                 }}>
//                 <View
//                   style={{
//                     backgroundColor: theme.colors.button1,
//                     borderRadius: 8,
//                     paddingVertical: 8,
//                     paddingHorizontal: 14,
//                     marginRight: 10,
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.buttonText1,
//                       fontWeight: '600',
//                       fontSize: 13,
//                     }}>
//                     Schedule This Outfit
//                   </Text>
//                 </View>

//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     paddingVertical: 8.5,
//                     paddingHorizontal: 14,
//                     borderRadius: 8,
//                     backgroundColor:
//                       theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                   }}>
//                   <Text
//                     style={{
//                       color: theme.colors.foreground,
//                       fontWeight: '600',
//                       fontSize: 13,
//                     }}>
//                     Cancel Schedule
//                   </Text>
//                 </View>
//               </View>

//               {/* Tags */}
//               {(outfit.tags || []).length > 0 && (
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     marginTop: 8,
//                   }}>
//                   {outfit.tags?.map(tag => (
//                     <View
//                       key={tag}
//                       style={{
//                         paddingHorizontal: 10,
//                         paddingVertical: 6,
//                         backgroundColor:
//                           theme.colors.input2 ?? 'rgba(43,43,43,1)',
//                         borderRadius: 16,
//                         marginRight: 6,
//                         marginBottom: 6,
//                       }}>
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           color: theme.colors.foreground,
//                         }}>
//                         #{tag}
//                       </Text>
//                     </View>
//                   ))}
//                 </View>
//               )}
//             </View>
//             <Text
//               style={{
//                 fontSize: 12,
//                 color: theme.colors.foreground2,
               
//                 textAlign: 'center',
//               }}>
//               Saved outfit cards will appear here ^
//             </Text>
//           </View>
//         );
//       }

//       return (
//         <SwipeableCard
//           key={outfit.id}
//           deleteThreshold={0.15}
//           onSwipeLeft={() => {
//             setPendingDeleteId(outfit.id);
//             setShowDeleteConfirm(true);
//           }}
//           deleteBackground={
//             <View
//               style={{
//                 flex: 1,
//                 alignItems: 'flex-end',
//                 justifyContent: 'center',
//                 paddingRight: 24,
//               }}
//             />
//           }>
//           <View style={{paddingHorizontal: 6}}>
//             <ViewShot
//               ref={ref => {
//                 viewRefs.current[outfit.id] = ref;
//               }}
//               options={{format: 'png', quality: 0.9}}>
//               <ScalePressable
//                 onPress={() => setFullScreenOutfit(outfit)}
//                 style={[globalStyles.cardStyles1, {marginBottom: 12}]}>
//                 {/* 🧵 Outfit Header Row */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     justifyContent: 'space-between',
//                     alignItems: 'center',
//                   }}>
//                   <View style={{flex: 1, marginRight: 12}}>
//                     <View
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         gap: 8,
//                       }}>
//                       <Text
//                         style={[
//                           globalStyles.titleBold,
//                           {
//                             fontSize: 20,
//                             color: theme.colors.foreground,
//                             flex: 1,
//                           },
//                         ]}>
//                         {outfit.name?.trim() || 'Unnamed Outfit'}
//                       </Text>
//                     </View>

//                     {/* 🗓️ Date & Time Info */}
//                     {(outfit.createdAt || outfit.plannedDate) && (
//                       <View style={{marginTop: 6}}>
//                         {outfit.plannedDate && (
//                           <Text
//                             style={[
//                               styles.timestamp,
//                               {
//                                 fontSize: 13,
//                                 fontWeight: '600',
//                                 color: theme.colors.foreground2,
//                               },
//                             ]}>
//                             {`Planned for ${new Date(
//                               outfit.plannedDate,
//                             ).toLocaleString([], {
//                               month: 'short',
//                               day: 'numeric',
//                               hour: 'numeric',
//                               minute: '2-digit',
//                             })}`}
//                           </Text>
//                         )}
//                         {outfit.createdAt && (
//                           <Text
//                             style={[
//                               styles.timestamp,
//                               {
//                                 fontSize: 12,
//                                 color: theme.colors.muted,
//                               },
//                             ]}>
//                             {`Saved ${new Date(
//                               outfit.createdAt,
//                             ).toLocaleDateString([], {
//                               month: 'short',
//                               day: 'numeric',
//                               year: 'numeric',
//                             })}`}
//                           </Text>
//                         )}
//                       </View>
//                     )}
//                   </View>

//                   {/* ❤️ & ✏️ & 👕 Buttons */}
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                     }}>
//                     {/* ✏️ Edit */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         setEditingOutfitId(outfit.id);
//                         setEditedName(outfit.name || '');
//                         setEditedOccasion(outfit.occasion);
//                       }}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                         marginRight: 6,
//                       }}>
//                       <MaterialIcons
//                         name="edit"
//                         size={20}
//                         color={theme.colors.foreground}
//                       />
//                     </Pressable>

//                     {/* ❤️ Favorite */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         toggleFavorite(
//                           outfit.id,
//                           outfit.type === 'custom' ? 'custom' : 'suggestion',
//                         );
//                       }}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <MaterialIcons
//                         name="favorite"
//                         size={20}
//                         color={
//                           favorites.some(
//                             f =>
//                               f.id === outfit.id &&
//                               f.source ===
//                                 (outfit.type === 'custom'
//                                   ? 'custom'
//                                   : 'suggestion'),
//                           )
//                             ? 'red'
//                             : theme.colors.foreground
//                         }
//                       />
//                     </Pressable>
//                     {/* 📤 Share */}
//                     <Pressable
//                       onPress={() => handleSharePress(outfit)}
//                       style={{
//                         padding: 8,
//                         borderRadius: 14,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                         marginLeft: 6,
//                       }}>
//                       <MaterialIcons
//                         name="ios-share"
//                         size={20}
//                         color={theme.colors.primary}
//                       />
//                     </Pressable>
//                   </View>
//                 </View>

//                 {/* 👕 Outfit Images - canvas outfits show snapshot + grid, legacy shows row */}
//                 <View style={styles.imageRow}>
//                   {outfit.thumbnailUrl ? (
//                     <View style={{flexDirection: 'row', alignItems: 'flex-start'}}>
//                       {/* Left: Canvas snapshot */}
//                       <View style={{
//                         width: 130,
//                         height: 210,
//                         overflow: 'hidden',
//                         backgroundColor: theme.colors.surface,
//                         // borderColor: theme.colors.muted,
//                         // borderRadius: 8,
//                         // borderWidth: 1,
//                         marginBottom: 4
//                       }}>
//                         <FastImage
//                           source={{
//                             uri: outfit.thumbnailUrl,
//                             priority: FastImage.priority.normal,
//                             cache: FastImage.cacheControl.web,
//                           }}
//                           style={{
//                             width: 130,
//                             height: 210,
//                             borderRadius: 8,
                       
//                           }}
//                           resizeMode={FastImage.resizeMode.contain}
//                         />
//                       </View>
//                       {/* Right: 4x3 Grid of individual items */}
//                       <View style={{marginLeft: 12, flexDirection: 'row', flexWrap: 'wrap', width: 250, gap: 4}}>
//                         {(outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((item, index) => {
//                           console.log(`🖼️ Grid item (2) ${item?.id}: ${item?.image?.substring(0, 80)}`);
//                           return item?.image ? (
//                             <FastImage
//                               key={item.id || index}
//                               source={{
//                                 uri: item.image,
//                                 priority: FastImage.priority.normal,
//                                 cache: FastImage.cacheControl.web,
//                               }}
//                               style={{width: 55, height: 55, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.muted}}
//                               resizeMode={FastImage.resizeMode.contain}
//                             />
//                           ) : null;
//                         })}
//                       </View>
//                     </View>
//                   ) : (
//                     (outfit.allItems || [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map((i, idx) =>
//                       i?.image ? (
//                         <FastImage
//                           key={i.id || idx}
//                           source={{
//                             uri: i.image,
//                             priority: FastImage.priority.normal,
//                             cache: FastImage.cacheControl.web,
//                           }}
//                           style={[
//                             globalStyles.image1,
//                             {
//                               marginRight: 2,
//                               borderRadius: 8,
//                               marginBottom: 8,
//                               marginTop: -6,
//                             },
//                           ]}
//                           resizeMode={FastImage.resizeMode.contain}
//                         />
//                       ) : null,
//                     )
//                   )}
//                 </View>

//                 {/* 📝 Notes */}
//                 {outfit.notes?.trim() && (
//                   <Text style={styles.notes}>"{outfit.notes.trim()}"</Text>
//                 )}

//                 {/* WORN COLOR */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   {/* Left 50% */}
//                   <View
//                     style={{
//                       flex: 1,
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                     }}>
//                     {/* 👕 Mark as worn (tap to increment, long press to decrement) */}
//                     <Pressable
//                       onPress={() => {
//                         hSelect();
//                         markWornMutation.mutate({
//                           userId,
//                           outfitId: outfit.id,
//                           outfitType: outfit.type,
//                         });
//                       }}
//                       onLongPress={() => {
//                         if ((outfit.timesWorn ?? 0) <= 0) return;
//                         hSelect();
//                         unmarkWornMutation.mutate({
//                           userId,
//                           outfitId: outfit.id,
//                           outfitType: outfit.type,
//                         });
//                       }}
//                       delayLongPress={500}
//                       style={{
//                         paddingVertical: 4.5,
//                         borderRadius: 8,
//                         paddingHorizontal: 12,
//                         backgroundColor:
//                           theme.colors.button1 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <MaterialIcons
//                         name="checkroom"
//                         size={22}
//                         color={theme.colors.buttonText1}
//                       />
//                     </Pressable>

//                     {(outfit.timesWorn ?? 0) > 0 && (
//                       <View
//                         style={{
//                           flexDirection: 'row',
//                           alignItems: 'center',
//                           backgroundColor: theme.colors.surface,
//                           paddingHorizontal: 9,
//                           borderRadius: 12,
//                         }}>
//                         <Text
//                           style={{
//                             fontSize: 16,
//                             fontWeight: '700',
//                             color: theme.colors.foreground,
//                           }}>
//                           Worn:
//                           {outfit.timesWorn} x{' '}
//                         </Text>
//                       </View>
//                     )}
//                   </View>

//                   {/* Right 50% - Occasion Chip */}
//                   <View
//                     style={{
//                       flex: 1,
//                       flexDirection: 'row',
//                       alignItems: 'center',
//                       justifyContent: 'flex-start',
//                     }}>
//                     {outfit.occasion && OCCASION_CONFIG[outfit.occasion] && (
//                       <Pressable
//                         onPress={() => {
//                           hSelect();
//                           setEditingOutfitId(outfit.id);
//                           setEditedName(outfit.name || '');
//                           setEditedOccasion(outfit.occasion);
//                         }}
//                         style={{
//                           flexDirection: 'row',
//                           alignItems: 'center',
//                           backgroundColor: `${
//                             OCCASION_CONFIG[outfit.occasion].color
//                           }`,
//                           paddingHorizontal: 14,
//                           paddingVertical: 9,
//                           borderRadius: 50,
//                         }}>
//                         <MaterialIcons
//                           name={OCCASION_CONFIG[outfit.occasion].icon as any}
//                           size={14}
//                           color={theme.colors.foreground}
//                           style={{marginRight: 5}}
//                         />
//                         <Text
//                           style={{
//                             fontSize: 12,
//                             fontWeight: '600',
//                             color: theme.colors.foreground,
//                           }}>
//                           {OCCASION_CONFIG[outfit.occasion].label}
//                         </Text>
//                       </Pressable>
//                     )}
//                   </View>
//                 </View>

//                 {/* 📅 Schedule & Cancel Buttons – keep them working */}
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     justifyContent: 'flex-start',
//                     flexWrap: 'wrap',
//                     marginTop: 8,
//                   }}>
//                   <AppleTouchFeedback
//                     hapticStyle="impactLight"
//                     onPress={() => {
//                       setPlanningOutfitId(outfit.id);
//                       const now = new Date();
//                       setSelectedTempDate(now);
//                       setSelectedTempTime(now);
//                       setShowDatePicker(true);
//                     }}
//                     style={{
//                       backgroundColor: theme.colors.button1,
//                       borderRadius: 8,
//                       paddingVertical: 8,
//                       paddingHorizontal: 14,
//                       marginRight: 10,
//                     }}>
//                     <Text
//                       style={{
//                         color: theme.colors.buttonText1,
//                         fontWeight: '600',
//                         fontSize: 13,
//                       }}>
//                       Schedule This Outfit
//                     </Text>
//                   </AppleTouchFeedback>

//                   {outfit.plannedDate && (
//                     <AppleTouchFeedback
//                       hapticStyle="impactLight"
//                       onPress={() => {
//                         cancelPlannedOutfit(outfit.id);
//                       }}
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         paddingVertical: 8.5,
//                         paddingHorizontal: 14,
//                         borderRadius: 8,
//                         marginLeft: 16,
//                         backgroundColor:
//                           theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                       }}>
//                       <Text
//                         style={{
//                           color: theme.colors.foreground,
//                           fontWeight: '600',
//                           fontSize: 13,
//                         }}>
//                         Cancel Schedule
//                       </Text>
//                     </AppleTouchFeedback>
//                   )}
//                 </View>

//                 {/* 🏷️ Tags */}
//                 {(outfit.tags || []).length > 0 && (
//                   <View
//                     style={{
//                       flexDirection: 'row',
//                       flexWrap: 'wrap',
//                       marginTop: 8,
//                     }}>
//                     {outfit.tags?.map(tag => (
//                       <View
//                         key={tag}
//                         style={{
//                           paddingHorizontal: 10,
//                           paddingVertical: 6,
//                           backgroundColor:
//                             theme.colors.input2 ?? 'rgba(43,43,43,1)',
//                           borderRadius: 16,
//                           marginRight: 6,
//                           marginBottom: 6,
//                         }}>
//                         <Text
//                           style={{
//                             fontSize: 12,
//                             color: theme.colors.foreground,
//                           }}>
//                           #{tag}
//                         </Text>
//                       </View>
//                     ))}
//                   </View>
//                 )}
//               </ScalePressable>
//             </ViewShot>
//           </View>
//         </SwipeableCard>
//       );
//     },
//     [
//       favorites,
//       theme,
//       globalStyles,
//       styles,
//       userId,
//       toggleFavorite,
//       markWornMutation,
//       unmarkWornMutation,
//       outfitsState,
//     ],
//   );

//   const keyExtractor = useCallback((item: SavedOutfit) => item.id, []);

//   // Override item layout for FlashList optimization
//   const overrideItemLayout = useCallback(
//     (layout: {span?: number; size?: number}): void => {
//       layout.size = ESTIMATED_CARD_HEIGHT;
//     },
//     [],
//   );

//   return (
//     <SafeAreaView
//       edges={['top']}
//       style={[
//         globalStyles.screen,
//         globalStyles.container,
//         {backgroundColor: theme.colors.background, paddingBottom: 0},
//       ]}>
//       {/* Hidden 2x2 grid composite for sharing */}
//       {shareOutfit && (
//         <View style={{position: 'absolute', left: -9999, top: -9999}}>
//           <ViewShot
//             ref={shareCompositeRef}
//             options={{format: 'png', quality: 0.95}}
//             style={{
//               width: SHARE_SIZE,
//               height: SHARE_SIZE + 80,
//               backgroundColor: '#F5F5F5',
//             }}>
//             {/* 2x2 Grid */}
//             {/* Row 1 */}
//             <View style={{flexDirection: 'row', height: SHARE_CELL}}>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.top?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderBottomWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.bottom?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//             </View>
//             {/* Row 2 */}
//             <View style={{flexDirection: 'row', height: SHARE_CELL}}>
//               <View style={{width: SHARE_CELL, height: SHARE_CELL, backgroundColor: '#F5F5F5', borderRightWidth: 0.5, borderColor: '#000'}}>
//                 <Image
//                   source={{uri: shareOutfit.shoes?.image}}
//                   style={{width: '100%', height: '100%'}}
//                   resizeMode="cover"
//                 />
//               </View>
//               {/* Plain off-white cell */}
//               <View
//                 style={{
//                   width: SHARE_CELL,
//                   height: SHARE_CELL,
//                   backgroundColor: '#F5F5F5',
//                 }}
//               />
//             </View>

//             {/* Center watermark with tinted overlay */}
//             <View
//               style={{
//                 position: 'absolute',
//                 top: 0,
//                 left: 0,
//                 right: 0,
//                 bottom: 80,
//                 justifyContent: 'center',
//                 alignItems: 'center',
//               }}>
//               <View
//                 style={{
//                   backgroundColor: 'rgba(0,0,0,0.5)',
//                   paddingHorizontal: 32,
//                   paddingVertical: 16,
//                   borderRadius: 40,
//                   borderWidth: 1.5,
//                   borderColor: 'rgba(255,255,255,0.25)',
//                   shadowColor: '#000',
//                   shadowOffset: {width: 0, height: 4},
//                   shadowOpacity: 0.4,
//                   shadowRadius: 12,
//                 }}>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     fontSize: 10,
//                     fontWeight: '500',
//                     letterSpacing: 0.5,
//                     textAlign: 'center',
//                     marginBottom: 4,
//                   }}>
//                   Created on
//                 </Text>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     fontSize: 28,
//                     fontWeight: '800',
//                     letterSpacing: 1.5,
//                     textShadowColor: 'rgba(0,0,0,0.5)',
//                     textShadowOffset: {width: 0, height: 2},
//                     textShadowRadius: 4,
//                   }}>
//                   StylHelpr
//                 </Text>
//               </View>
//             </View>

//             {/* Bottom info section */}
//             <View
//               style={{
//                 height: 80,
//                 backgroundColor: 'rgba(144, 0, 255, 1)',
//                 paddingHorizontal: 20,
//                 paddingVertical: 16,
//               }}>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '700',
//                   color: '#fff',
//                   marginBottom: 8,
//                 }}
//                 numberOfLines={1}>
//                 {shareOutfit.name || 'My Outfit'}
//               </Text>
//               <View
//                 style={{
//                   flexDirection: 'row',
//                   alignItems: 'center',
//                   justifyContent: 'space-between',
//                 }}>
//                 <View style={{flexDirection: 'row', alignItems: 'center'}}>
//                   <View
//                     style={{
//                       width: 24,
//                       height: 24,
//                       borderRadius: 12,
//                       marginRight: 8,
//                       backgroundColor: '#000',
//                       overflow: 'hidden',
//                       justifyContent: 'center',
//                       alignItems: 'center',
//                     }}>
//                     {profilePicture ? (
//                       <Image
//                         source={{uri: profilePicture}}
//                         style={{
//                           width: 24,
//                           height: 24,
//                         }}
//                       />
//                     ) : (
//                       <Text
//                         style={{
//                           color: '#fff',
//                           fontSize: 10,
//                           fontWeight: '700',
//                         }}>
//                         SH
//                       </Text>
//                     )}
//                   </View>
//                   <Text
//                     style={{
//                       fontSize: 14,
//                       fontWeight: '500',
//                       color: '#fff',
//                     }}
//                     numberOfLines={1}>
//                     @{userName.toLowerCase() || 'stylhelpr'}
//                   </Text>
//                 </View>
//                 <Text
//                   style={{
//                     fontSize: 12,
//                     fontWeight: '400',
//                     color: 'rgba(255,255,255,0.8)',
//                   }}>
//                   {new Date(shareOutfit.createdAt).toLocaleDateString()}
//                 </Text>
//               </View>
//             </View>
//           </ViewShot>
//         </View>
//       )}

//       {/* 🧭 Spacer to restore old navbar height */}
//       <View
//         style={{
//           height: Math.max(insets.top - 10, 44), // ✅ min 44px for non-notched devices
//           backgroundColor: theme.colors.background,
//         }}
//       />
//       <View
//         style={{
//           flexDirection: 'row',
//           alignItems: 'center',
//           justifyContent: 'space-between',
//         }}>
//         <Text
//           style={[
//             globalStyles.header,
//             {color: theme.colors.primary, marginBottom: 0},
//           ]}>
//           Saved Outfits
//         </Text>
//         <View style={{flexDirection: 'row', gap: 8}}>
//           <TouchableOpacity
//             onPress={() => globalNavigate('OutfitsByOccasion')}
//             style={{
//               padding: 8,
//               borderRadius: 20,
//               backgroundColor: theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name="category"
//               size={24}
//               color={theme.colors.primary}
//             />
//           </TouchableOpacity>
//           <TouchableOpacity
//             onPress={() => globalNavigate('OutfitHistory')}
//             style={{
//               padding: 8,
//               marginRight: 16,
//               borderRadius: 20,
//               backgroundColor: theme.colors.surface,
//             }}>
//             <MaterialIcons
//               name="history"
//               size={24}
//               color={theme.colors.primary}
//             />
//           </TouchableOpacity>
//         </View>
//       </View>

//       <View style={[globalStyles.section]}>
//         <Text
//           style={[globalStyles.label, {marginBottom: 12, textAlign: 'left'}]}>
//           Sort by:
//         </Text>

//         {/* Responsive pills in one fixed row */}
//         <View
//           style={{
//             flexDirection: 'row',
//             justifyContent: 'space-between',
//             alignItems: 'center',
//             flexWrap: 'nowrap',
//           }}>
//           {(
//             [
//               {key: 'newest', label: 'Newest'},
//               {key: 'favorites', label: 'Favorites'},
//               {key: 'planned', label: 'Planned'},
//               {key: 'stars', label: 'Rating'},
//             ] as const
//           ).map(({key, label}, idx) => {
//             const screenWidth = Dimensions.get('window').width;
//             const totalSpacing = 12 * 3 + 32;
//             const pillWidth = (screenWidth - totalSpacing) / 4;

//             return (
//               <TouchableOpacity
//                 key={key}
//                 onPress={() => {
//                   hSelect();
//                   setSortType(key);
//                 }}
//                 activeOpacity={0.8}
//                 style={{
//                   backgroundColor:
//                     sortType === key
//                       ? theme.colors.foreground
//                       : theme.colors.surface3,
//                   paddingVertical: 9,
//                   borderRadius: 22,
//                   width: pillWidth,
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <Text
//                   numberOfLines={1}
//                   ellipsizeMode="clip"
//                   adjustsFontSizeToFit={false}
//                   style={{
//                     color:
//                       sortType === key
//                         ? theme.colors.background
//                         : theme.colors.foreground2,
//                     fontSize: 14,
//                     fontWeight: '600',
//                     textAlign: 'center',
//                   }}>
//                   {label}
//                 </Text>
//               </TouchableOpacity>
//             );
//           })}
//         </View>

//         {/* Occasion filter chips */}
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{
//             paddingVertical: 12,
//             gap: 8,
//           }}
//           style={{flexGrow: 0}}>
//           {/* "All" chip */}
//           <TouchableOpacity
//             onPress={() => setOccasionFilter(null)}
//             style={{
//               paddingHorizontal: 14,
//               paddingVertical: 8,
//               borderRadius: 16,
//               backgroundColor:
//                 occasionFilter === null
//                   ? theme.colors.button1
//                   : theme.colors.surface3,
//               borderWidth: 1,
//               borderColor:
//                 occasionFilter === null
//                   ? theme.colors.surfaceBorder
//                   : theme.colors.surfaceBorder,
//             }}>
//             <Text
//               style={{
//                 fontSize: 13,
//                 fontWeight: '600',
//                 color:
//                   occasionFilter === null ? 'white' : theme.colors.foreground,
//               }}>
//               All ({displayOutfits.length})
//             </Text>
//           </TouchableOpacity>

//           {/* Occasion chips */}
//           {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(occasion => {
//             const config = OCCASION_CONFIG[occasion];
//             const count = displayOutfits.filter(
//               o => o.occasion === occasion,
//             ).length;
//             if (count === 0) return null;
//             const isSelected = occasionFilter === occasion;

//             return (
//               <TouchableOpacity
//                 key={occasion}
//                 onPress={() => setOccasionFilter(isSelected ? null : occasion)}
//                 style={{
//                   flexDirection: 'row',
//                   alignItems: 'center',
//                   paddingHorizontal: 12,
//                   paddingVertical: 8,
//                   borderRadius: 16,
//                   backgroundColor: isSelected
//                     ? config.color
//                     : theme.colors.surface,
//                   borderWidth: 1,
//                   borderColor: isSelected
//                     ? config.color
//                     : theme.colors.surfaceBorder,
//                   gap: 6,
//                 }}>
//                 <MaterialIcons
//                   name={config.icon as any}
//                   size={16}
//                   color={isSelected ? '#fff' : config.color}
//                 />
//                 <Text
//                   style={{
//                     fontSize: 13,
//                     fontWeight: '600',
//                     color: isSelected ? '#fff' : theme.colors.foreground,
//                   }}>
//                   {config.label} ({count})
//                 </Text>
//               </TouchableOpacity>
//             );
//           })}
//         </ScrollView>
//       </View>

//       {/* Demo indicator banner */}
//       {outfitsState === 'demo' && (
//         <View
//           style={{
//             backgroundColor: theme.colors.primary + '20',
//             paddingVertical: 10,
//             paddingHorizontal: 16,
//             marginHorizontal: 16,
//             marginBottom: 12,
//             borderRadius: 10,
//             flexDirection: 'row',
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="info-outline"
//             size={20}
//             color={theme.colors.primary}
//             style={{marginRight: 8}}
//           />
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               fontSize: 14,
//               flex: 1,
//             }}>
//             This is a sample outfit card. Build your own outfits in "Wardrobe" or have "AI Outfit" create one and save them!
//           </Text>
//         </View>
//       )}

//       {/* 🪩 Virtualized FlashList */}
//       <View style={{flex: 1, width: '100%'}}>
//         {/* Empty state - only show when user had outfits before but now has none */}
//         {outfitsState === 'empty-real' && sortedOutfits.length === 0 ? (
//           <View
//             style={{
//               flexDirection: 'row',
//               alignSelf: 'center',
//               paddingTop: 40,
//             }}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved outfits.
//             </Text>
//             <TooltipBubble
//               message="You don't have any saved outfits yet. Tap Wardrobe in the bottom navigation bar to head to the Wardrobe screen, and then tap Build an Outfit. Once you build your first outfit, it will appear back here automatically."
//               position="top"
//             />
//           </View>
//         ) : sortedOutfits.length > 0 ? (
//           <FlashList
//             ref={flashListRef}
//             data={sortedOutfits}
//             renderItem={renderOutfitItem}
//             keyExtractor={keyExtractor}
//             overrideItemLayout={overrideItemLayout}
//             drawDistance={ESTIMATED_CARD_HEIGHT * 2}
//             showsVerticalScrollIndicator={false}
//             onScroll={handleScroll}
//             scrollEventThrottle={16}
//             contentContainerStyle={{
//               paddingBottom: 160,
//               paddingHorizontal: 10,
//             }}
//           />
//         ) : null}
//       </View>

//       {/* 📝 Edit Outfit Modal */}
//       {editingOutfitId && (
//         <BlurView
//           style={styles.modalContainer}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             animation="zoomIn"
//             duration={600}
//             style={[styles.modalContent, {maxHeight: '80%'}]}>
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontWeight: '700',
//                 fontSize: 18,
//                 marginBottom: 4,
//               }}>
//               Edit Outfit
//             </Text>

//             {/* Outfit Name Input */}
//             <Text
//               style={{
//                 color: theme.colors.foreground3,
//                 fontSize: 12,
//                 fontWeight: '600',
//                 marginTop: 12,
//                 marginBottom: 6,
//               }}>
//               NAME
//             </Text>
//             <TextInput
//               value={editedName}
//               onChangeText={setEditedName}
//               placeholder="Enter outfit name"
//               placeholderTextColor={theme.colors.foreground3}
//               style={styles.input}
//             />

//             {/* Occasion Selector */}
//             <Text
//               style={{
//                 color: theme.colors.foreground3,
//                 fontSize: 12,
//                 fontWeight: '600',
//                 marginTop: 16,
//                 marginBottom: 8,
//               }}>
//               OCCASION
//             </Text>

//             <ScrollView
//               horizontal
//               showsHorizontalScrollIndicator={false}
//               style={{marginBottom: 8}}>
//               <View style={{flexDirection: 'row', gap: 8, paddingRight: 16}}>
//                 {/* Clear occasion option */}
//                 <Pressable
//                   onPress={() => setEditedOccasion(undefined)}
//                   style={{
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     paddingHorizontal: 12,
//                     paddingVertical: 8,
//                     borderRadius: 16,
//                     backgroundColor: !editedOccasion
//                       ? theme.colors.primary
//                       : theme.colors.surface3,
//                     borderWidth: 1,
//                     borderColor: !editedOccasion
//                       ? theme.colors.primary
//                       : theme.colors.surfaceBorder,
//                   }}>
//                   <MaterialIcons
//                     name="close"
//                     size={14}
//                     color={!editedOccasion ? '#fff' : theme.colors.foreground3}
//                     style={{marginRight: 4}}
//                   />
//                   <Text
//                     style={{
//                       fontSize: 12,
//                       fontWeight: '600',
//                       color: !editedOccasion
//                         ? '#fff'
//                         : theme.colors.foreground3,
//                     }}>
//                     None
//                   </Text>
//                 </Pressable>

//                 {/* Occasion options */}
//                 {(Object.keys(OCCASION_CONFIG) as OutfitOccasion[]).map(key => {
//                   const config = OCCASION_CONFIG[key];
//                   const isSelected = editedOccasion === key;
//                   return (
//                     <Pressable
//                       key={key}
//                       onPress={() => setEditedOccasion(key)}
//                       style={{
//                         flexDirection: 'row',
//                         alignItems: 'center',
//                         paddingHorizontal: 12,
//                         paddingVertical: 10,
//                         borderRadius: 16,
//                         backgroundColor: isSelected
//                           ? `${config.color}`
//                           : theme.colors.surface3,
//                         borderWidth: 1,
//                         borderColor: isSelected
//                           ? config.color
//                           : theme.colors.surfaceBorder,
//                       }}>
//                       <MaterialIcons
//                         name={config.icon as any}
//                         size={14}
//                         color={theme.colors.foreground3}
//                         style={{marginRight: 4}}
//                       />
//                       <Text
//                         style={{
//                           fontSize: 12,
//                           fontWeight: '600',
//                           color: theme.colors.foreground3,
//                         }}>
//                         {config.label}
//                       </Text>
//                     </Pressable>
//                   );
//                 })}
//               </View>
//             </ScrollView>

//             <View style={[styles.modalActions, {marginTop: 16}]}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   setEditingOutfitId(null);
//                   setEditedName('');
//                   setEditedOccasion(undefined);
//                 }}>
//                 <Text style={{color: theme.colors.foreground, marginRight: 24}}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={handleNameSave}>
//                 <Text style={{color: theme.colors.primary, fontWeight: '700'}}>
//                   Save
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Animatable.View>
//         </BlurView>
//       )}

//       {/* 📅 Date/Time Picker — Combined Bottom Sheet */}
//       {(showDatePicker || showTimePicker) && planningOutfitId && (
//         <BlurView
//           style={[styles.overlay, {marginTop: 0}]}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             ref={datePickerRef}
//             animation="fadeInUp"
//             duration={1000}
//             easing="ease-out-quint"
//             style={[styles.sheetContainer]}>
//             <View style={styles.grabber} />
//             <View style={styles.sheetHeaderRow}>
//               <Text style={styles.sheetTitle}>
//                 {showDatePicker ? 'Pick a date' : 'Pick a time'}
//               </Text>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={resetPlanFlow}
//                 style={styles.sheetPill}>
//                 <Text style={styles.sheetPillText}>Close</Text>
//               </AppleTouchFeedback>
//             </View>

//             <View
//               style={{
//                 position: 'relative',
//                 backgroundColor: showDatePicker
//                   ? theme.colors.background
//                   : theme.colors.background,
//                 borderRadius: 25,
//                 paddingBottom: insets.bottom + 10,
//                 paddingTop: showDatePicker ? 6 : 12,
//                 alignItems: 'center',
//                 overflow: 'hidden',
//               }}>
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 0,
//                   left: 0,
//                   right: 0,
//                   bottom: 0,
//                   opacity: showDatePicker ? 1 : 0,
//                   pointerEvents: showDatePicker ? 'auto' : 'none',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <DateTimePicker
//                   value={selectedTempDate || new Date()}
//                   mode="date"
//                   display="spinner"
//                   themeVariant="dark"
//                   textColor={theme.colors.foreground}
//                   onChange={(e, d) => d && setSelectedTempDate(new Date(d))}
//                   style={{marginVertical: -10}}
//                 />
//               </View>
//               <View
//                 style={{
//                   opacity: showTimePicker ? 1 : 0,
//                   pointerEvents: showTimePicker ? 'auto' : 'none',
//                 }}>
//                 <DateTimePicker
//                   value={selectedTempTime || new Date()}
//                   mode="time"
//                   display="spinner"
//                   textColor={theme.colors.foreground}
//                   onChange={(e, t) => t && setSelectedTempTime(new Date(t))}
//                   style={{
//                     width: '100%',
//                     transform: [{scale: 1.05}],
//                     opacity: 1.0,
//                   }}
//                 />
//               </View>
//             </View>

//             <View style={styles.sheetFooterRow}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={resetPlanFlow}
//                 style={[
//                   styles.sheetPill,
//                   {
//                     backgroundColor: showDatePicker
//                       ? theme.colors.surface
//                       : theme.colors.input2,
//                   },
//                 ]}>
//                 <Text style={styles.sheetPillText}>Cancel</Text>
//               </AppleTouchFeedback>
//               {showDatePicker ? (
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setShowTimePicker(true);
//                     setShowDatePicker(false);
//                   }}
//                   style={[
//                     styles.sheetPill,
//                     {backgroundColor: theme.colors.background},
//                   ]}>
//                   <Text
//                     style={{color: theme.colors.foreground, fontWeight: '800'}}>
//                     Next: Time
//                   </Text>
//                 </AppleTouchFeedback>
//               ) : (
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={commitSchedule}
//                   style={[
//                     styles.sheetPill,
//                     {backgroundColor: theme.colors.button1},
//                   ]}>
//                   <Text
//                     style={{
//                       color: theme.colors.buttonText1,
//                       fontWeight: '800',
//                     }}>
//                     Done
//                   </Text>
//                 </AppleTouchFeedback>
//               )}
//             </View>
//           </Animatable.View>
//         </BlurView>
//       )}

//       {/* 🧼 Deleted Toast (undo not available since delete is server-side) */}
//       {lastDeletedOutfit && (
//         <Animatable.View
//           animation="bounceInUp"
//           duration={800}
//           easing="ease-out-back"
//           style={styles.toast}>
//           <Text style={{color: theme.colors.foreground}}>Outfit deleted</Text>
//         </Animatable.View>
//       )}

//       {/* 🗑 Delete Confirmation */}
//       <Modal
//         visible={showDeleteConfirm && !!pendingDeleteId}
//         transparent
//         animationType="fade">
//         <BlurView
//           style={styles.modalContainer}
//           blurType="dark"
//           blurAmount={20}
//           reducedTransparencyFallbackColor="rgba(0,0,0,0.7)">
//           <Animatable.View
//             animation="zoomIn"
//             duration={500}
//             style={styles.modalContent}>
//             <Text
//               style={{
//                 fontSize: 16,
//                 color: theme.colors.foreground,
//                 fontWeight: '700',
//                 marginBottom: 8,
//               }}>
//               Delete this outfit?
//             </Text>
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 18,
//               }}>
//               This action cannot be undone.
//             </Text>
//             <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   setShowDeleteConfirm(false);
//                   setPendingDeleteId(null);
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     marginHorizontal: 16,
//                   }}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>
//               <AppleTouchFeedback
//                 hapticStyle="notificationWarning"
//                 onPress={() => {
//                   if (pendingDeleteId) handleDelete(pendingDeleteId);
//                   setShowDeleteConfirm(false);
//                   setPendingDeleteId(null);
//                 }}>
//                 <Text style={{color: theme.colors.error, fontWeight: '800'}}>
//                   Delete
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Animatable.View>
//         </BlurView>
//       </Modal>

//       {/* 📤 Share Options Modal */}
//       <Modal
//         visible={shareOptionsVisible}
//         transparent
//         animationType="fade"
//         onRequestClose={() => setShareOptionsVisible(false)}>
//         <Pressable
//           style={styles.modalContainer}
//           onPress={() => setShareOptionsVisible(false)}>
//           <BlurView
//             style={StyleSheet.absoluteFill}
//             blurType="dark"
//             blurAmount={20}
//             reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
//           />
//           <Animatable.View
//             animation="slideInUp"
//             duration={300}
//             style={[
//               styles.modalContent,
//               {
//                 width: '90%',
//                 maxWidth: 340,
//                 paddingVertical: 20,
//               },
//             ]}>
//             <Text
//               style={{
//                 fontSize: 18,
//                 fontWeight: '700',
//                 color: theme.colors.foreground,
//                 marginBottom: 20,
//                 textAlign: 'center',
//               }}>
//               Share Outfit
//             </Text>

//             {/* Share to Community */}
//             <AppleTouchFeedback
//               hapticStyle="impactMedium"
//               onPress={handleShareToCommunity}
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: theme.colors.button1,
//                 paddingVertical: 14,
//                 paddingHorizontal: 20,
//                 borderRadius: 14,
//                 marginBottom: 12,
//               }}>
//               <MaterialIcons
//                 name="groups"
//                 size={24}
//                 color={theme.colors.buttonText1}
//               />
//               <Text
//                 style={{
//                   color: theme.colors.buttonText1,
//                   fontSize: 16,
//                   fontWeight: '600',
//                   marginLeft: 12,
//                 }}>
//                 Share to Community
//               </Text>
//             </AppleTouchFeedback>

//             {/* Share Externally */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={handleShareExternal}
//               style={{
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 backgroundColor: theme.colors.surface2,
//                 paddingVertical: 14,
//                 paddingHorizontal: 20,
//                 marginBottom: 12,
//                 borderRadius: 14,
//                 borderWidth: tokens.borderWidth.md,
//                 borderColor: theme.colors.muted,
//               }}>
//               <MaterialIcons
//                 name="ios-share"
//                 size={24}
//                 color={theme.colors.foreground}
//               />
//               <Text
//                 style={{
//                   color: theme.colors.foreground,
//                   fontSize: 16,
//                   fontWeight: '600',
//                   marginLeft: 12,
//                 }}>
//                 Share via...
//               </Text>
//             </AppleTouchFeedback>

//             {/* Cancel */}
//             <AppleTouchFeedback
//               hapticStyle="selection"
//               onPress={() => {
//                 setShareOptionsVisible(false);
//                 setPendingShareOutfit(null);
//               }}
//               style={{
//                 paddingVertical: 12,
//                 alignItems: 'center',
//                 borderRadius: 14,
//                 borderWidth: tokens.borderWidth.md,
//                 borderColor: theme.colors.muted,
//               }}>
//               <Text
//                 style={{
//                   color: theme.colors.muted,
//                   fontSize: 16,
//                 }}>
//                 Cancel
//               </Text>
//             </AppleTouchFeedback>
//           </Animatable.View>
//         </Pressable>
//       </Modal>

//       {/* 🌐 Community Share Modal */}
//       <Modal
//         visible={communityShareModalVisible}
//         transparent
//         animationType="fade"
//         onRequestClose={() => setCommunityShareModalVisible(false)}>
//         <Pressable
//           style={styles.modalContainer}
//           onPress={() => setCommunityShareModalVisible(false)}>
//           <BlurView
//             style={StyleSheet.absoluteFill}
//             blurType="dark"
//             blurAmount={20}
//             reducedTransparencyFallbackColor="rgba(0,0,0,0.7)"
//           />
//           <Pressable
//             onPress={e => e.stopPropagation()}
//             style={[
//               styles.modalContent,
//               {
//                 width: '90%',
//                 maxWidth: 360,
//                 paddingVertical: 24,
//               },
//             ]}>
//             <Text
//               style={{
//                 fontSize: 18,
//                 fontWeight: '700',
//                 color: theme.colors.foreground,
//                 marginBottom: 20,
//                 textAlign: 'center',
//               }}>
//               Share to Community
//             </Text>

//             {/* Description Input */}
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 8,
//               }}>
//               Description
//             </Text>
//             <TextInput
//               value={communityDescription}
//               onChangeText={setCommunityDescription}
//               placeholder={
//                 pendingShareOutfit?.name || 'Describe your outfit...'
//               }
//               placeholderTextColor={theme.colors.muted}
//               multiline
//               style={{
//                 backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                 borderRadius: 12,
//                 padding: 14,
//                 color: theme.colors.foreground,
//                 fontSize: 15,
//                 minHeight: 80,
//                 marginBottom: 16,
//                 textAlignVertical: 'top',
//               }}
//             />

//             {/* Tags Input */}
//             <Text
//               style={{
//                 fontSize: 14,
//                 color: theme.colors.foreground2,
//                 marginBottom: 8,
//               }}>
//               Tags (comma-separated)
//             </Text>
//             <TextInput
//               value={communityTags}
//               onChangeText={setCommunityTags}
//               placeholder="casual, summer, streetwear..."
//               placeholderTextColor={theme.colors.muted}
//               style={{
//                 backgroundColor: theme.colors.surface3 ?? 'rgba(43,43,43,1)',
//                 borderRadius: 12,
//                 padding: 14,
//                 color: theme.colors.foreground,
//                 fontSize: 15,
//                 marginBottom: 24,
//               }}
//             />

//             {/* Action Buttons */}
//             <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
//               <AppleTouchFeedback
//                 hapticStyle="selection"
//                 onPress={() => {
//                   setCommunityShareModalVisible(false);
//                   setPendingShareOutfit(null);
//                 }}
//                 style={{paddingHorizontal: 20, paddingVertical: 12}}>
//                 <Text style={{color: theme.colors.muted, fontSize: 16}}>
//                   Cancel
//                 </Text>
//               </AppleTouchFeedback>

//               <AppleTouchFeedback
//                 hapticStyle="impactMedium"
//                 onPress={handleConfirmCommunityShare}
//                 style={{
//                   backgroundColor: theme.colors.button1,
//                   paddingHorizontal: 24,
//                   paddingVertical: 12,
//                   borderRadius: 12,
//                   marginLeft: 12,
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.buttonText1,
//                     fontSize: 16,
//                     fontWeight: '600',
//                   }}>
//                   {createPostMutation.isPending ? 'Sharing...' : 'Share'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Pressable>
//         </Pressable>
//       </Modal>

//       {/* 🖼 Full-Screen Outfit Modal — IMMERSIVE VERSION */}
//       <Modal
//         visible={!!fullScreenOutfit}
//         transparent
//         animationType="slide"
//         presentationStyle="overFullScreen"
//         statusBarTranslucent
//         onDismiss={() => translateY.setValue(0)}
//         onRequestClose={() => setFullScreenOutfit(null)}>
//         <SafeAreaView
//           style={{flex: 1, backgroundColor: 'transparent'}}
//           edges={[]}>
//           <Animated.View
//             style={{
//               flex: 1,
//               backgroundColor: '#000',
//               transform: [{translateY}],
//               width: '100%',
//               height: '100%',
//               marginTop: 60,
//             }}>
//             {/* Backdrop */}
//             <View
//               style={[
//                 StyleSheet.absoluteFill,
//                 {backgroundColor: theme.colors.background},
//               ]}
//             />

//             {/* Close Button ABOVE gesture zone */}
//             <TouchableOpacity
//               style={{
//                 position: 'absolute',
//                 top: 11,
//                 right: 18,
//                 zIndex: 20,
//                 borderRadius: 20,
//                 borderWidth: tokens.borderWidth.hairline,
//                 borderColor: theme.colors.muted,
//                 paddingHorizontal: 8,
//                 paddingVertical: 6,
//               }}
//               onPress={handleClose}
//               hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
//               <Text style={{color: theme.colors.foreground, fontSize: 20}}>
//                 X
//               </Text>
//             </TouchableOpacity>

//             {/* Swipe Gesture Zone */}
//             <View
//               {...panResponder.panHandlers}
//               style={{
//                 position: 'absolute',
//                 top: 45,
//                 height: 80,
//                 width: '100%',
//                 zIndex: 999,
//               }}
//               onStartShouldSetResponder={() => true}
//             />

//             {/* Outfit Scroll Content */}
//             <ScrollView
//               showsVerticalScrollIndicator={false}
//               style={{flex: 1, width: '100%'}}
//               contentContainerStyle={{
//                 paddingBottom: 180,
//                 alignItems: 'center',
//                 paddingHorizontal: 24,
//               }}>
//               {/* Outfit Name */}
//               <Animatable.Text
//                 animation="fadeInDown"
//                 delay={200}
//                 duration={700}
//                 style={{
//                   fontSize: 28,
//                   fontWeight: '800',
//                   color: theme.colors.foreground,
//                   textAlign: 'center',
//                   marginTop: 25,
//                   marginBottom: 20,
//                   letterSpacing: 0.5,
//                 }}>
//                 {fullScreenOutfit?.name || 'Unnamed Outfit'}
//               </Animatable.Text>

//               {/* Snapshot Image (Canvas Outfits) - Show first if available */}
//               {fullScreenOutfit?.thumbnailUrl && (
//                 <Animatable.View
//                   animation="fadeInUp"
//                   delay={300}
//                   duration={800}
//                   style={{
//                     width: '100%',
//                     maxWidth: 400,
//                     marginBottom: 28,
//                     alignItems: 'center',
//                   }}>
//                   <FastImage
//                     source={{
//                       uri: fullScreenOutfit.thumbnailUrl,
//                       priority: FastImage.priority.high,
//                       cache: FastImage.cacheControl.web,
//                     }}
//                     style={{
//                       width: '100%',
//                       height: 450,
//                       borderRadius: 20,
//                       borderWidth: tokens.borderWidth.hairline,
//                       borderColor: theme.colors.muted,
//                     }}
//                     resizeMode={FastImage.resizeMode.contain}
//                   />
//                   <Text
//                     style={{
//                       color: 'rgba(255,255,255,0.85)',
//                       fontSize: 14,
//                       fontWeight: '500',
//                       marginTop: 10,
//                       textAlign: 'center',
//                     }}>
//                     Full Outfit
//                   </Text>
//                 </Animatable.View>
//               )}

//               {/* Individual Outfit Items - Using FastImage */}
//               {(fullScreenOutfit?.allItems || [fullScreenOutfit?.top, fullScreenOutfit?.bottom, fullScreenOutfit?.shoes].filter(Boolean)).map(
//                 (i, idx) =>
//                   i?.image && (
//                     <Animatable.View
//                       key={i?.id || idx}
//                       animation="fadeInUp"
//                       delay={fullScreenOutfit?.thumbnailUrl ? 500 + idx * 200 : 300 + idx * 200}
//                       duration={800}
//                       style={{
//                         width: '100%',
//                         maxWidth: 400,
//                         marginBottom: 28,
//                         alignItems: 'center',
//                       }}>
//                       <FastImage
//                         source={{
//                           uri: i.image,
//                           priority: FastImage.priority.high,
//                           cache: FastImage.cacheControl.web,
//                         }}
//                         style={{
//                           width: '100%',
//                           height: 400,
//                           borderRadius: 20,
//                           borderWidth: tokens.borderWidth.hairline,
//                           borderColor: theme.colors.muted,
//                         }}
//                         resizeMode={FastImage.resizeMode.contain}
//                       />
//                       {i.name && (
//                         <Text
//                           style={{
//                             color: 'rgba(255,255,255,0.85)',
//                             fontSize: 14,
//                             fontWeight: '500',
//                             marginTop: 10,
//                             textAlign: 'center',
//                           }}>
//                           {i.name}
//                         </Text>
//                       )}
//                     </Animatable.View>
//                   ),
//               )}

//               {/* Notes */}
//               {fullScreenOutfit?.notes?.trim() && (
//                 <Animatable.Text
//                   animation="fadeInUp"
//                   delay={700}
//                   duration={800}
//                   style={{
//                     fontStyle: 'italic',
//                     fontSize: 16,
//                     color: 'rgba(255,255,255,0.9)',
//                     textAlign: 'center',
//                     marginTop: 10,
//                     lineHeight: 22,
//                   }}>
//                   "{fullScreenOutfit.notes.trim()}"
//                 </Animatable.Text>
//               )}

//               {/* Tags */}
//               {fullScreenOutfit?.tags?.length ? (
//                 <Animatable.View
//                   animation="fadeInUp"
//                   delay={900}
//                   duration={800}
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     justifyContent: 'center',
//                     marginTop: 24,
//                   }}>
//                   {fullScreenOutfit.tags.map(tag => (
//                     <View
//                       key={tag}
//                       style={{
//                         backgroundColor: 'rgba(255,255,255,0.1)',
//                         borderRadius: 20,
//                         paddingHorizontal: 14,
//                         paddingVertical: 6,
//                         margin: 6,
//                       }}>
//                       <Text
//                         style={{
//                           color: '#fff',
//                           fontSize: 14,
//                           fontWeight: '600',
//                           letterSpacing: 0.2,
//                         }}>
//                         #{tag}
//                       </Text>
//                     </View>
//                   ))}
//                 </Animatable.View>
//               ) : null}
//             </ScrollView>
//           </Animated.View>
//         </SafeAreaView>
//       </Modal>

//       {/* Scroll-to-top button */}
//       <AppleTouchFeedback
//         onPress={() => {
//           flashListRef.current?.scrollToOffset({offset: 0, animated: true});
//         }}
//         style={{
//           position: 'absolute',
//           bottom: 100,
//           right: 20,
//           width: 48,
//           height: 48,
//           borderRadius: 24,
//           backgroundColor: 'rgba(0,0,0,0.6)',
//           borderColor: theme.colors.muted,
//           borderWidth: tokens.borderWidth.md,
//           alignItems: 'center',
//           justifyContent: 'center',
//           shadowColor: '#000',
//           shadowOpacity: 0.3,
//           shadowRadius: 8,
//           shadowOffset: {width: 0, height: 4},
//         }}>
//         <MaterialIcons name="keyboard-arrow-up" size={32} color="#fff" />
//       </AppleTouchFeedback>
//     </SafeAreaView>
//   );
// }
