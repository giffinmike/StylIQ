import React, {useState, useMemo, useCallback, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {useAppTheme} from '../../context/ThemeContext';
import {useUUID} from '../../context/UUIDContext';
import {API_BASE_URL} from '../../config/api';
import {useWardrobeItems} from '../../hooks/useWardrobeItems';
import CategoryTabs, {Category} from './CategoryTabs';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {tokens} from '../../styles/tokens/tokens';

const {height: SCREEN_HEIGHT} = Dimensions.get('window');
const DRAWER_COLLAPSED_HEIGHT = 150;
const DRAWER_EXPANDED_HEIGHT = SCREEN_HEIGHT * 0.5;
const ITEM_SIZE = 95;

type WardrobeItem = {
  id: string;
  image?: string;
  image_url?: string;
  thumbnailUrl?: string;
  processedImageUrl?: string;
  touchedUpImageUrl?: string;
  name?: string;
  main_category?: string;
  mainCategory?: string;
};

type Props = {
  onAddItem: (item: WardrobeItem) => void;
  placedItemIds: string[]; // Items already on canvas
};

// Category mapping logic (from OutfitBuilderScreen)
const categorizeItem = (item: WardrobeItem): Category => {
  const cat = (item.main_category || item.mainCategory || '').toLowerCase();

  // Exact-match new categories first (items explicitly labeled with new main_category)
  if (cat === 'outerwear') return 'Outerwear';
  if (cat === 'dresses') return 'Dresses';
  if (cat === 'skirts') return 'Skirts';
  if (cat === 'bags') return 'Bags';
  if (cat === 'headwear') return 'Headwear';
  if (cat === 'jewelry') return 'Jewelry';

  if (
    ['tops', 'shirts', 'knitwear', 'sweaters', 'blouses', 't-shirts'].some(
      c => cat.includes(c),
    )
  ) {
    return 'Tops';
  }
  if (
    ['jackets', 'blazers', 'coats'].some(
      c => cat.includes(c),
    )
  ) {
    return 'Outerwear';
  }
  if (
    ['bottoms', 'pants', 'trousers', 'shorts', 'skirts', 'jeans', 'denim'].some(
      c => cat.includes(c),
    )
  ) {
    return 'Bottoms';
  }
  if (
    ['shoes', 'sneakers', 'loafers', 'boots', 'heels', 'sandals', 'footwear'].some(
      c => cat.includes(c),
    )
  ) {
    return 'Shoes';
  }
  if (
    ['accessories', 'hats', 'scarves', 'belts', 'bags', 'glasses', 'watches'].some(
      c => cat.includes(c),
    )
  ) {
    return 'Accessories';
  }
  return 'Accessories'; // Default fallback
};

export default function ItemDrawer({onAddItem, placedItemIds}: Props) {
    const {theme} = useAppTheme();
    const globalStyles = useGlobalStyles();
  const userId = useUUID();
  const [selectedCategory, setSelectedCategory] = useState<Category>('All');
  const [isExpanded, setIsExpanded] = useState(false);

  // Clear FastImage cache on mount to ensure fresh images
  useEffect(() => {
    FastImage.clearMemoryCache();
    FastImage.clearDiskCache();
  }, []);

  // Animated drawer height
  const drawerHeight = useSharedValue(DRAWER_COLLAPSED_HEIGHT);

  // Fetch wardrobe items using shared hook (returns processed images)
  const {data: wardrobeData, isLoading, isError} = useWardrobeItems(userId || '');
  const wardrobe = Array.isArray(wardrobeData) ? wardrobeData : [];

  // Filter items by category
  const filteredItems = useMemo(() => {
    if (selectedCategory === 'All') {
      return wardrobe;
    }
    return wardrobe.filter(
      (item: WardrobeItem) => categorizeItem(item) === selectedCategory,
    );
  }, [wardrobe, selectedCategory]);

  // Resolve image URL - backend computes best URL in 'image' field
  // Use || instead of ?? to treat empty strings as falsy
  const resolveUri = useCallback((item: WardrobeItem) => {
    // Backend now computes 'image' with priority: touchedUp > processed > original
    // Check 'image' first, then fallbacks for legacy data
    const u =
      item.image ||
      item.touchedUpImageUrl ||
      item.processedImageUrl ||
      item.thumbnailUrl ||
      item.image_url;
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    const base = API_BASE_URL.replace(/\/+$/, '');
    const path = u.replace(/^\/+/, '');
    return `${base}/${path}`;
  }, []);

  const handleAddItem = useCallback(
    (item: WardrobeItem) => {
      // Don't add if already on canvas
      if (placedItemIds.includes(item.id)) {
        ReactNativeHapticFeedback.trigger('notificationWarning', {
          enableVibrateFallback: true,
          ignoreAndroidSystemSettings: false,
        });
        return;
      }
      ReactNativeHapticFeedback.trigger('impactLight', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });
      onAddItem(item);
    },
    [onAddItem, placedItemIds],
  );

  const toggleExpand = useCallback(() => {
    ReactNativeHapticFeedback.trigger('selection', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    drawerHeight.value = withTiming(
      newExpanded ? DRAWER_EXPANDED_HEIGHT : DRAWER_COLLAPSED_HEIGHT,
      {duration: 250, easing: Easing.out(Easing.cubic)},
    );
  }, [isExpanded, drawerHeight]);

  // Shared value to track expanded state for gesture calculations
  const isExpandedShared = useSharedValue(isExpanded);

  // Keep shared value in sync with React state
  React.useEffect(() => {
    isExpandedShared.value = isExpanded;
  }, [isExpanded, isExpandedShared]);

  // Pan gesture for drawer expand/collapse
  const panGesture = Gesture.Pan()
    .onUpdate(event => {
      const newHeight = isExpandedShared.value
        ? DRAWER_EXPANDED_HEIGHT - event.translationY
        : DRAWER_COLLAPSED_HEIGHT - event.translationY;
      drawerHeight.value = Math.max(
        DRAWER_COLLAPSED_HEIGHT,
        Math.min(DRAWER_EXPANDED_HEIGHT, newHeight),
      );
    })
    .onEnd(event => {
      const shouldExpand =
        event.velocityY < -500 ||
        drawerHeight.value > (DRAWER_COLLAPSED_HEIGHT + DRAWER_EXPANDED_HEIGHT) / 2;
      isExpandedShared.value = shouldExpand;
      runOnJS(setIsExpanded)(shouldExpand);
      drawerHeight.value = withTiming(
        shouldExpand ? DRAWER_EXPANDED_HEIGHT : DRAWER_COLLAPSED_HEIGHT,
        {duration: 250, easing: Easing.out(Easing.cubic)},
      );
    });

  const animatedStyle = useAnimatedStyle(() => ({
    height: drawerHeight.value,
  }));

  const styles = StyleSheet.create({
    container: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: -4},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 8,
      overflow: 'hidden',
    },
    handle: {
      alignItems: 'center',
      paddingVertical: 10,
    },
    handleBar: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.muted || 'rgba(0,0,0,0.2)',
    },
    content: {
      flex: 1,
    },
    itemsContainer: {
      paddingHorizontal: 12,
      paddingBottom: 20,
     
    },
    itemsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      justifyContent: 'center'
    },
    itemWrapper: {
      width: ITEM_SIZE,
      height: ITEM_SIZE,
      borderRadius: tokens.borderRadius.switch1,
      overflow: 'hidden',
      backgroundColor: theme.colors.imageBackground,
    },
    itemWrapperDisabled: {
      opacity: 0.4,
    },
    itemImage: {
      width: '100%',
      height: '100%',
    },
    checkOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    loading: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 30,
    },
    emptyText: {
      textAlign: 'center',
      color: theme.colors.muted || theme.colors.foreground,
      fontSize: 14,
      paddingVertical: 20,
    },
  });

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={[styles.container, animatedStyle]}>
        <TouchableOpacity
          style={styles.handle}
          onPress={toggleExpand}
          activeOpacity={0.8}>
          <View style={styles.handleBar} />
        </TouchableOpacity>

        <View style={styles.content}>
          <CategoryTabs
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
          />

          {isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator size="small" color={theme.colors.foreground} />
            </View>
          ) : filteredItems.length === 0 ? (
            <Text style={styles.emptyText}>No items in this category</Text>
          ) : (
            <ScrollView
              contentContainerStyle={styles.itemsContainer}
              showsVerticalScrollIndicator={false}>
              <View style={styles.itemsRow}>
                {filteredItems.map((item: WardrobeItem) => {
                  const isPlaced = placedItemIds.includes(item.id);
                  const resolvedUri = resolveUri(item);
                  // // Debug: log FULL URLs being used
                  // console.log('[ItemDrawer] FULL URLS:', {
                  //   id: item.id,
                  //   image: item.image,
                  //   touchedUpImageUrl: item.touchedUpImageUrl,
                  //   processedImageUrl: item.processedImageUrl,
                  //   image_url: item.image_url,
                  //   resolved: resolvedUri,
                  // });
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[
                        styles.itemWrapper,
                        isPlaced && styles.itemWrapperDisabled,
                      ]}
                      onPress={() => handleAddItem(item)}
                      activeOpacity={0.7}
                      disabled={isPlaced}>
                      <FastImage
                        source={{
                          uri: resolvedUri,
                          cache: FastImage.cacheControl.web,
                        }}
                        style={styles.itemImage}
                        resizeMode={FastImage.resizeMode.contain}
                      />
                      {isPlaced && (
                        <View style={styles.checkOverlay}>
                          <MaterialIcons
                            name="check-circle"
                            size={28}
                            color="white"
                          />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
