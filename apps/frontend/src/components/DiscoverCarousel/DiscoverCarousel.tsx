import React, {useEffect, useState, useRef, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  Linking,
  Animated,
  Easing,
  Pressable,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ActivityIndicator,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {isTablet, isLargePhone, isRegularPhone} from '../../styles/global';

// Card dimensions for auto-scroll calculation
const CARD_WIDTH = isTablet
  ? 160
  : isLargePhone
    ? 160
    : isRegularPhone
      ? 160
      : 160;
const CARD_MARGIN = isTablet
  ? 16
  : isLargePhone
    ? 10
    : isRegularPhone
      ? 10
      : 10;
const SCROLL_INTERVAL = CARD_WIDTH + CARD_MARGIN;
const AUTO_SCROLL_DELAY = 10000; // 10 seconds

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
      toValue: 0.96,
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

// Thumb button style constants
const THUMB_SIZE = 24;
const THUMB_ICON_SIZE = 14;
const THUMB_BG_DEFAULT = 'rgba(0,0,0,0.7)';
const THUMB_BG_LIKE = '#16A34A';
const THUMB_BG_DISLIKE = '#DC2626';
const THUMB_ICON_COLOR = '#FFFFFF';
const THUMB_ANIM_DURATION = 160;

// Animated icon button with scale tap feedback and circular background
const AnimatedIconButton = ({
  onPress,
  iconName,
  activeIconName,
  isActive,
  activeColor,
  isLoading,
}: {
  onPress: (e: any) => void;
  iconName: string;
  activeIconName: string;
  isActive: boolean;
  activeColor: string;
  isLoading?: boolean;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.timing(scaleAnim, {
      toValue: 0.88,
      duration: THUMB_ANIM_DURATION,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.timing(scaleAnim, {
      toValue: 1,
      duration: THUMB_ANIM_DURATION,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
      <Animated.View
        style={{
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: THUMB_SIZE / 2,
          backgroundColor: isActive ? activeColor : THUMB_BG_DEFAULT,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{scale: scaleAnim}],
        }}>
        {isLoading ? (
          <ActivityIndicator size="small" color={THUMB_ICON_COLOR} />
        ) : (
          <MaterialIcons
            name={isActive ? activeIconName : iconName}
            size={THUMB_ICON_SIZE}
            color={THUMB_ICON_COLOR}
          />
        )}
      </Animated.View>
    </Pressable>
  );
};
import {useUUID} from '../../context/UUIDContext';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {useAppTheme} from '../../context/ThemeContext';
import {apiClient} from '../../lib/apiClient';

type Product = {
  id: string;
  product_id: string;
  title: string;
  brand: string;
  image_url: string;
  link: string;
  category: string;
  saved?: boolean;
  disliked?: boolean;
};

type DiscoverCarouselProps = {
  onOpenItem?: (url: string, title?: string, product?: Product) => void;
  onDismiss?: (product: Product) => void;
  savedModalVisible?: boolean;
  onCloseSavedModal?: () => void;
  onSavedProductsChange?: (
    products: Product[],
    fetchFn: () => void,
    unsaveFn: (productId: string) => void,
    updateProductSavedFn: (productId: string, saved: boolean) => void,
  ) => void;
};

export type DiscoverProduct = Product;

const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({
  onOpenItem,
  onDismiss,
  savedModalVisible: externalSavedModalVisible,
  onCloseSavedModal,
  onSavedProductsChange,
}) => {
  const userId = useUUID();
  const cacheKey = userId ? `discover_products_${userId}` : null;
  const [recommended, setRecommended] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();

  // Saved products modal state - use external control if provided
  const [internalSavedModalVisible, setInternalSavedModalVisible] =
    useState(false);
  const savedModalVisible =
    externalSavedModalVisible ?? internalSavedModalVisible;
  const [savedProducts, setSavedProducts] = useState<Product[]>([]);
  const [savingProductId, setSavingProductId] = useState<string | null>(null);

  // Track locally unsaved product IDs to ensure heart icon shows correct state
  const [locallyUnsavedIds, setLocallyUnsavedIds] = useState<Set<string>>(new Set());

  // Track disliked product IDs (thumbs-down)
  const [dislikedIds, setDislikedIds] = useState<Set<string>>(new Set());

  // --- Liked products persistence (AsyncStorage cache, backend authoritative) ---
  const likedKey = userId ? `liked_products_${userId}` : null;
  const lastLikedMutationTs = useRef<number>(0);

  const loadLikedProducts = useCallback(async (): Promise<Product[]> => {
    if (!likedKey) return [];
    try {
      const raw = await AsyncStorage.getItem(likedKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }, [likedKey]);

  const persistLikedProducts = useCallback(
    async (products: Product[]) => {
      if (!likedKey) return;
      try {
        await AsyncStorage.setItem(likedKey, JSON.stringify(products));
      } catch {}
    },
    [likedKey],
  );

  // Compute display items with corrected saved state
  const displayItems = useMemo(
    () =>
      recommended.map(item => ({
        ...item,
        saved: item.saved && !locallyUnsavedIds.has(item.product_id),
      })),
    [recommended, locallyUnsavedIds],
  );

  const fadeAnims = useRef<Animated.Value[]>([]);
  const translateAnims = useRef<Animated.Value[]>([]);

  // Auto-scroll refs
  const scrollViewRef = useRef<ScrollView>(null);
  const currentIndexRef = useRef(0);
  const autoScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isUserScrollingRef = useRef(false);

  // Auto-scroll effect - scrolls every 10 seconds
  useEffect(() => {
    if (recommended.length <= 1) return;

    const startAutoScroll = () => {
      autoScrollTimerRef.current = setInterval(() => {
        if (isUserScrollingRef.current) return;

        currentIndexRef.current =
          (currentIndexRef.current + 1) % recommended.length;
        const scrollX = currentIndexRef.current * SCROLL_INTERVAL;

        scrollViewRef.current?.scrollTo({
          x: scrollX,
          animated: true,
        });
      }, AUTO_SCROLL_DELAY);
    };

    startAutoScroll();

    return () => {
      if (autoScrollTimerRef.current) {
        clearInterval(autoScrollTimerRef.current);
      }
    };
  }, [recommended.length]);

  // Handle scroll events to sync current index and pause auto-scroll during user interaction
  const handleScrollBeginDrag = useCallback(() => {
    isUserScrollingRef.current = true;
  }, []);

  const handleScrollEndDrag = useCallback(() => {
    // Resume auto-scroll after a short delay
    setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 2000);
  }, []);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      currentIndexRef.current = Math.round(offsetX / SCROLL_INTERVAL);
    },
    [],
  );

  // Toggle save/unsave a product (thumbs up) — optimistic update
  const handleToggleSave = useCallback(
    async (product: Product) => {
      if (!userId || savingProductId) return;

      // Clear dislike if active (persist to backend)
      if (dislikedIds.has(product.product_id)) {
        setDislikedIds(prev => {
          const next = new Set(prev);
          next.delete(product.product_id);
          return next;
        });
        setRecommended(prev =>
          prev.map(p =>
            p.product_id === product.product_id ? {...p, disliked: false} : p,
          ),
        );
        apiClient.post(`/discover/${userId}/undo-dismiss`, {
          product_id: product.product_id,
        }).catch(() => {});
      }

      // Optimistic: flip saved state immediately
      const newSaved = !product.saved;
      setSavingProductId(product.product_id);
      setRecommended(prev =>
        prev.map(p =>
          p.product_id === product.product_id ? {...p, saved: newSaved} : p,
        ),
      );
      if (newSaved) {
        setLocallyUnsavedIds(prev => {
          const next = new Set(prev);
          next.delete(product.product_id);
          return next;
        });
      }
      ReactNativeHapticFeedback.trigger('impactLight', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });

      // Optimistic liked store update + mutation guard
      lastLikedMutationTs.current = Date.now();
      let prevSavedProducts: Product[] = [];
      if (newSaved) {
        setSavedProducts(prev => {
          prevSavedProducts = prev;
          const exists = prev.some(p => p.product_id === product.product_id);
          const updated = exists ? prev : [...prev, {...product, saved: true}];
          persistLikedProducts(updated);
          return updated;
        });
      } else {
        setSavedProducts(prev => {
          prevSavedProducts = prev;
          const updated = prev.filter(p => p.product_id !== product.product_id);
          persistLikedProducts(updated);
          return updated;
        });
      }

      try {
        const response = await apiClient.post(`/discover/${userId}/toggle-save`, {
          product_id: product.product_id,
        });

        const result = response.data;
        // Reconcile with server truth
        setRecommended(prev =>
          prev.map(p =>
            p.product_id === product.product_id
              ? {...p, saved: result.saved}
              : p,
          ),
        );
      } catch (err) {
        // Revert optimistic update on error — BOTH recommended AND liked store
        setRecommended(prev =>
          prev.map(p =>
            p.product_id === product.product_id
              ? {...p, saved: product.saved}
              : p,
          ),
        );
        setSavedProducts(prevSavedProducts);
        persistLikedProducts(prevSavedProducts);
        console.error('Failed to toggle save:', err);
      } finally {
        setSavingProductId(null);
      }
    },
    [userId, savingProductId, dislikedIds, persistLikedProducts],
  );

  // Toggle dislike on a product (thumbs down) — no removal, persists disliked field
  const handleDismiss = useCallback(
    async (product: Product) => {
      ReactNativeHapticFeedback.trigger('impactLight', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });
      if (dislikedIds.has(product.product_id)) {
        // Undo — clear disliked state
        setDislikedIds(prev => {
          const next = new Set(prev);
          next.delete(product.product_id);
          return next;
        });
        setRecommended(prev =>
          prev.map(p =>
            p.product_id === product.product_id ? {...p, disliked: false} : p,
          ),
        );
        if (userId) {
          apiClient.post(`/discover/${userId}/undo-dismiss`, {
            product_id: product.product_id,
          }).catch(() => {});
        }
      } else {
        // If saved, unsave optimistically + remove from liked store
        if (product.saved && userId) {
          setRecommended(prev =>
            prev.map(p =>
              p.product_id === product.product_id ? {...p, saved: false} : p,
            ),
          );
          lastLikedMutationTs.current = Date.now();
          let prevSaved: Product[] = [];
          setSavedProducts(prev => {
            prevSaved = prev;
            const updated = prev.filter(p => p.product_id !== product.product_id);
            persistLikedProducts(updated);
            return updated;
          });
          apiClient.post(`/discover/${userId}/toggle-save`, {
            product_id: product.product_id,
          }).catch(err => {
            console.error('Failed to unsave on dislike:', err);
            // Revert liked store on backend failure
            setSavedProducts(prevSaved);
            persistLikedProducts(prevSaved);
            setRecommended(prev =>
              prev.map(p =>
                p.product_id === product.product_id ? {...p, saved: true} : p,
              ),
            );
          });
        }
        setDislikedIds(prev => new Set(prev).add(product.product_id));
        setRecommended(prev =>
          prev.map(p =>
            p.product_id === product.product_id ? {...p, disliked: true} : p,
          ),
        );
        onDismiss?.(product);
      }
    },
    [onDismiss, dislikedIds, userId, persistLikedProducts],
  );

  // Fetch saved products for modal (backend authoritative, with grace window guard)
  const fetchSavedProducts = useCallback(async () => {
    if (!userId) return;
    try {
      const response = await apiClient.get(`/discover/${userId}/saved`);
      // Grace window: if a local mutation happened < 3s ago, fully ignore
      // this GET result to prevent stale backend data from overwriting
      // the optimistic state (no UI update, no AsyncStorage write).
      if (Date.now() - lastLikedMutationTs.current < 3000) {
        return;
      }
      const apiProducts: Product[] = response.data;
      setSavedProducts(apiProducts);
      persistLikedProducts(apiProducts);
    } catch (err) {
      console.error('Failed to fetch saved products:', err);
      // On API failure, keep existing local cache (graceful degradation)
    }
  }, [userId, persistLikedProducts]);

  // Close saved modal
  const handleCloseSavedModal = useCallback(() => {
    if (onCloseSavedModal) {
      onCloseSavedModal();
    } else {
      setInternalSavedModalVisible(false);
    }
  }, [onCloseSavedModal]);

  // Fetch saved products when modal becomes visible
  useEffect(() => {
    if (savedModalVisible) {
      fetchSavedProducts();
    }
  }, [savedModalVisible, fetchSavedProducts]);

  // Handle unsave from parent (updates local state + liked store)
  const handleUnsaveFromParent = useCallback((productId: string) => {
    lastLikedMutationTs.current = Date.now();
    setSavedProducts(prev => {
      const updated = prev.filter(p => p.product_id !== productId);
      persistLikedProducts(updated);
      return updated;
    });
    setRecommended(prev =>
      prev.map(p => (p.product_id === productId ? {...p, saved: false} : p)),
    );
    // Also track in local set to ensure heart icon updates immediately
    setLocallyUnsavedIds(prev => new Set(prev).add(productId));
  }, [persistLikedProducts]);

  // Update a product's saved state from parent (e.g., when toggled in ReaderModal)
  const handleUpdateProductSaved = useCallback((productId: string, saved: boolean) => {
    lastLikedMutationTs.current = Date.now();
    setRecommended(prev => {
      const product = prev.find(p => p.product_id === productId);
      // Also update liked store
      if (saved && product) {
        setSavedProducts(sp => {
          const exists = sp.some(p => p.product_id === productId);
          const updated = exists ? sp : [...sp, {...product, saved: true}];
          persistLikedProducts(updated);
          return updated;
        });
      } else if (!saved) {
        setSavedProducts(sp => {
          const updated = sp.filter(p => p.product_id !== productId);
          persistLikedProducts(updated);
          return updated;
        });
      }
      return prev.map(p => (p.product_id === productId ? {...p, saved} : p));
    });
    if (!saved) {
      setLocallyUnsavedIds(prev => new Set(prev).add(productId));
    } else {
      setLocallyUnsavedIds(prev => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  }, [persistLikedProducts]);

  // Expose saved products to parent
  useEffect(() => {
    onSavedProductsChange?.(
      savedProducts,
      fetchSavedProducts,
      handleUnsaveFromParent,
      handleUpdateProductSaved,
    );
  }, [
    savedProducts,
    fetchSavedProducts,
    handleUnsaveFromParent,
    handleUpdateProductSaved,
    onSavedProductsChange,
  ]);

  // 💾 Load cache → check daily freshness (after 5 AM) → conditionally fetch
  useEffect(() => {
    if (!userId || !cacheKey) return;

    let cancelled = false;

    (async () => {
      // Phase 1: Instant liked-products hydration from AsyncStorage cache
      const localLiked = await loadLikedProducts();
      if (!cancelled && localLiked.length > 0) {
        setSavedProducts(localLiked);
      }

      // Step 1: Load cached recommended products instantly
      let cacheHit = false;
      let cacheFresh = false;
      try {
        const rawProducts = await AsyncStorage.getItem(cacheKey);

        if (rawProducts && !cancelled) {
          const items: Product[] = JSON.parse(rawProducts);
          if (items.length > 0) {
            setRecommended(items);
            setDislikedIds(
              new Set(items.filter(p => p.disliked).map(p => p.product_id)),
            );
            setLoading(false);
            cacheHit = true;

            // If already fetched today (after 5 AM local), skip API call
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const now = new Date();
            const localDateStr = now.toLocaleDateString('en-CA', {timeZone: tz}); // YYYY-MM-DD
            const localHour = Number(
              new Intl.DateTimeFormat('en-US', {hour: 'numeric', hour12: false, timeZone: tz}).format(now),
            );
            const dayKey = `discover_fetch_day_${userId}`;
            const storedDay = await AsyncStorage.getItem(dayKey);
            if (localHour < 5) {
              // Before 5 AM: no new fetch allowed, prior day's data is still fresh
              if (storedDay) cacheFresh = true;
            } else if (storedDay === localDateStr) {
              // After 5 AM and already fetched today
              cacheFresh = true;
            }
          }
        }
      } catch {}

      if (cancelled) return;

      // Step 2: Fetch recommended from API (only if no cache or stale cache)
      if (!cacheFresh) {
        if (!cacheHit) setLoading(true);
        try {
          const resp = await apiClient.get(
            `/discover/${encodeURIComponent(userId)}`,
          );
          if (cancelled) return;
          const data = resp.data;
          const items: Product[] = data
            .map((p: any) => ({
              id: String(p.id),
              product_id: p.product_id || String(p.id),
              title: p.title,
              brand: p.brand,
              image_url: p.image_url,
              link: p.link,
              category: p.category,
              saved: p.saved === true || p.saved === 't' || p.saved === 'true',
              disliked:
                p.disliked === true ||
                p.disliked === 't' ||
                p.disliked === 'true',
            }))
            .filter((p: Product) => p.image_url?.startsWith('http'));
          setDislikedIds(
            new Set(items.filter(p => p.disliked).map(p => p.product_id)),
          );
          setLocallyUnsavedIds(new Set());
          setRecommended(items);
          setError(null);

          // Persist fresh data + today's date
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const todayStr = new Date().toLocaleDateString('en-CA', {timeZone: tz});
          const dayKey = `discover_fetch_day_${userId}`;
          await Promise.all([
            AsyncStorage.setItem(cacheKey, JSON.stringify(items)),
            AsyncStorage.setItem(dayKey, todayStr),
          ]).catch(() => {});
        } catch (e: any) {
          if (!cancelled && !cacheHit) {
            setError(e.message || 'Failed to load');
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }

      // Phase 2: Backend sync for liked products (always runs, backend authoritative)
      if (!cancelled) {
        fetchSavedProducts();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, cacheKey]);

  // 💾 Persist to cache whenever recommended changes (thumbs state, etc.)
  useEffect(() => {
    if (!cacheKey || recommended.length === 0) return;
    AsyncStorage.setItem(cacheKey, JSON.stringify(recommended)).catch(() => {});
  }, [cacheKey, recommended]);

  // 🎬 Trigger animations whenever list changes
  useEffect(() => {
    fadeAnims.current = recommended.map(() => new Animated.Value(0));
    translateAnims.current = recommended.map(() => new Animated.Value(20));

    const anims = recommended.map((_, i) =>
      Animated.parallel([
        Animated.timing(fadeAnims.current[i], {
          toValue: 1,
          duration: 450,
          delay: i * 120,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(translateAnims.current[i], {
          toValue: 0,
          duration: 450,
          delay: i * 120,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    Animated.stagger(100, anims).start();

    return () => {
      fadeAnims.current.forEach(anim => anim?.stopAnimation?.());
      translateAnims.current.forEach(anim => anim?.stopAnimation?.());
    };
  }, [recommended.length]);

  // 🪛 Loading & error states
  if (loading) return <Text style={{padding: 16}}>Loading…</Text>;
  if (error && recommended.length === 0)
    return <Text style={{padding: 16}}>{error}</Text>;

  return (
    <>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}>
        {recommended.length === 0 ? (
          <Text style={{padding: 16, color: theme.colors.foreground2}}>
            No picks found
          </Text>
        ) : (
          displayItems.map((item, i) => (
            <Animated.View
              key={item.product_id || item.id || `discover-${i}`}
              style={{
                opacity: fadeAnims.current[i] || new Animated.Value(1),
                transform: [
                  {
                    translateY:
                      translateAnims.current[i] || new Animated.Value(0),
                  },
                ],
              }}>
              <ScalePressable
                style={globalStyles.outfitCard2}
                onPress={() => {
                  if (onOpenItem) {
                    onOpenItem(item.link, item.title, item);
                  } else {
                    Linking.openURL(item.link || '#');
                  }
                }}>
                {/* Image with heart overlay */}
                <View style={{position: 'relative', width: '100%'}}>
                  <Image
                    source={{uri: item.image_url}}
                    style={[globalStyles.image7, {backgroundColor: theme.colors.imageBackground}]}
                    resizeMode="cover"
                    // resizeMode="contain"
                    onError={() =>
                      console.warn('⚠️ image failed', item.image_url)
                    }
                  />
                  {/* Heart + Thumbs-down stacked vertically */}
                  <View
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      alignItems: 'center',
                      gap: 6,
                    }}>
                    {/* Thumbs up icon */}
                    <AnimatedIconButton
                      onPress={e => {
                        e.stopPropagation();
                        handleToggleSave(item);
                      }}
                      iconName="thumb-up"
                      activeIconName="thumb-up"
                      isActive={!!item.saved}
                      activeColor={THUMB_BG_LIKE}
                      isLoading={savingProductId === item.product_id}
                    />
                    {/* Thumbs down icon */}
                    <AnimatedIconButton
                      onPress={e => {
                        e.stopPropagation();
                        handleDismiss(item);
                      }}
                      iconName="thumb-down-off-alt"
                      activeIconName="thumb-down"
                      isActive={dislikedIds.has(item.product_id)}
                      activeColor={THUMB_BG_DISLIKE}
                    />
                  </View>
                </View>

                <Text
                  style={[
                    globalStyles.cardLabel,
                    {
                      // marginHorizontal: 10,
                      marginTop: 6,
                      // textTransform: 'uppercase'
                    },
                  ]}
                  numberOfLines={1}>
                  {item.title || 'Untitled'}
                </Text>
                <Text
                  style={[
                    globalStyles.cardSubLabel,
                    {
                      // marginHorizontal: 10,
                      // marginBottom: 8,
                    },
                  ]}
                     numberOfLines={1}>
                  {item.brand || 'Brand'}
                </Text>
              </ScalePressable>
            </Animated.View>
          ))
        )}
      </ScrollView>
    </>
  );
};

export default DiscoverCarousel;

//////////////////

// import React, {useEffect, useState, useRef, useCallback, useMemo} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   Linking,
//   Animated,
//   Easing,
//   Pressable,
//   NativeSyntheticEvent,
//   NativeScrollEvent,
//   TouchableOpacity,
//   ActivityIndicator,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {isTablet, isLargePhone, isRegularPhone} from '../../styles/global';

// // Card dimensions for auto-scroll calculation
// const CARD_WIDTH = isTablet
//   ? 160
//   : isLargePhone
//     ? 180
//     : isRegularPhone
//       ? 160
//       : 160;
// const CARD_MARGIN = isTablet
//   ? 16
//   : isLargePhone
//     ? 10
//     : isRegularPhone
//       ? 10
//       : 10;
// const SCROLL_INTERVAL = CARD_WIDTH + CARD_MARGIN;
// const AUTO_SCROLL_DELAY = 10000; // 10 seconds

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
//       toValue: 0.96,
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
// import {useUUID} from '../../context/UUIDContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import {apiClient} from '../../lib/apiClient';

// type Product = {
//   id: string;
//   product_id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
//   saved?: boolean;
// };

// type DiscoverCarouselProps = {
//   onOpenItem?: (url: string, title?: string) => void;
//   savedModalVisible?: boolean;
//   onCloseSavedModal?: () => void;
//   onSavedProductsChange?: (
//     products: Product[],
//     fetchFn: () => void,
//     unsaveFn: (productId: string) => void,
//   ) => void;
// };

// export type DiscoverProduct = Product;

// const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({
//   onOpenItem,
//   savedModalVisible: externalSavedModalVisible,
//   onCloseSavedModal,
//   onSavedProductsChange,
// }) => {
//   const userId = useUUID();
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   // Saved products modal state - use external control if provided
//   const [internalSavedModalVisible, setInternalSavedModalVisible] =
//     useState(false);
//   const savedModalVisible =
//     externalSavedModalVisible ?? internalSavedModalVisible;
//   const [savedProducts, setSavedProducts] = useState<Product[]>([]);
//   const [savingProductId, setSavingProductId] = useState<string | null>(null);

//   // Track locally unsaved product IDs to ensure heart icon shows correct state
//   const [locallyUnsavedIds, setLocallyUnsavedIds] = useState<Set<string>>(new Set());

//   // Compute display items with corrected saved state
//   const displayItems = useMemo(
//     () =>
//       recommended.map(item => ({
//         ...item,
//         saved: item.saved && !locallyUnsavedIds.has(item.product_id),
//       })),
//     [recommended, locallyUnsavedIds],
//   );

//   const fadeAnims = useRef<Animated.Value[]>([]);
//   const translateAnims = useRef<Animated.Value[]>([]);

//   // Auto-scroll refs
//   const scrollViewRef = useRef<ScrollView>(null);
//   const currentIndexRef = useRef(0);
//   const autoScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
//   const isUserScrollingRef = useRef(false);

//   // Auto-scroll effect - scrolls every 10 seconds
//   useEffect(() => {
//     if (recommended.length <= 1) return;

//     const startAutoScroll = () => {
//       autoScrollTimerRef.current = setInterval(() => {
//         if (isUserScrollingRef.current) return;

//         currentIndexRef.current =
//           (currentIndexRef.current + 1) % recommended.length;
//         const scrollX = currentIndexRef.current * SCROLL_INTERVAL;

//         scrollViewRef.current?.scrollTo({
//           x: scrollX,
//           animated: true,
//         });
//       }, AUTO_SCROLL_DELAY);
//     };

//     startAutoScroll();

//     return () => {
//       if (autoScrollTimerRef.current) {
//         clearInterval(autoScrollTimerRef.current);
//       }
//     };
//   }, [recommended.length]);

//   // Handle scroll events to sync current index and pause auto-scroll during user interaction
//   const handleScrollBeginDrag = useCallback(() => {
//     isUserScrollingRef.current = true;
//   }, []);

//   const handleScrollEndDrag = useCallback(() => {
//     // Resume auto-scroll after a short delay
//     setTimeout(() => {
//       isUserScrollingRef.current = false;
//     }, 2000);
//   }, []);

//   const handleMomentumScrollEnd = useCallback(
//     (event: NativeSyntheticEvent<NativeScrollEvent>) => {
//       const offsetX = event.nativeEvent.contentOffset.x;
//       currentIndexRef.current = Math.round(offsetX / SCROLL_INTERVAL);
//     },
//     [],
//   );

//   // Toggle save/unsave a product
//   const handleToggleSave = useCallback(
//     async (product: Product) => {
//       if (!userId || savingProductId) return;

//       setSavingProductId(product.product_id);
//       ReactNativeHapticFeedback.trigger('impactLight', {
//         enableVibrateFallback: true,
//         ignoreAndroidSystemSettings: false,
//       });

//       try {
//         const response = await apiClient.post(`/discover/${userId}/toggle-save`, {
//           product_id: product.product_id,
//         });

//         const result = response.data;
//         // Update local state
//         setRecommended(prev =>
//           prev.map(p =>
//             p.product_id === product.product_id
//               ? {...p, saved: result.saved}
//               : p,
//           ),
//         );
//       } catch (err) {
//         console.error('Failed to toggle save:', err);
//       } finally {
//         setSavingProductId(null);
//       }
//     },
//     [userId, savingProductId],
//   );

//   // Fetch saved products for modal
//   const fetchSavedProducts = useCallback(async () => {
//     if (!userId) return;
//     try {
//       const response = await apiClient.get(`/discover/${userId}/saved`);
//       setSavedProducts(response.data);
//     } catch (err) {
//       console.error('Failed to fetch saved products:', err);
//     }
//   }, [userId]);

//   // Close saved modal
//   const handleCloseSavedModal = useCallback(() => {
//     if (onCloseSavedModal) {
//       onCloseSavedModal();
//     } else {
//       setInternalSavedModalVisible(false);
//     }
//   }, [onCloseSavedModal]);

//   // Fetch saved products when modal becomes visible
//   useEffect(() => {
//     if (savedModalVisible) {
//       fetchSavedProducts();
//     }
//   }, [savedModalVisible, fetchSavedProducts]);

//   // Handle unsave from parent (updates local state)
//   const handleUnsaveFromParent = useCallback((productId: string) => {
//     setSavedProducts(prev => prev.filter(p => p.product_id !== productId));
//     setRecommended(prev =>
//       prev.map(p => (p.product_id === productId ? {...p, saved: false} : p)),
//     );
//     // Also track in local set to ensure heart icon updates immediately
//     setLocallyUnsavedIds(prev => new Set(prev).add(productId));
//   }, []);

//   // Expose saved products to parent
//   useEffect(() => {
//     onSavedProductsChange?.(
//       savedProducts,
//       fetchSavedProducts,
//       handleUnsaveFromParent,
//     );
//   }, [
//     savedProducts,
//     fetchSavedProducts,
//     handleUnsaveFromParent,
//     onSavedProductsChange,
//   ]);

//   // ⏱️ Initial delay for mount
//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   // 📡 Fetch data
//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         // console.log('🛒 DiscoverCarousel: fetching /discover/' + userId);
//         const resp = await apiClient.get(`/discover/${encodeURIComponent(userId)}`);
//         const data = resp.data;
//         // console.log('🛒 DiscoverCarousel: raw response length:', data?.length, 'first item:', data?.[0]);
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             product_id: p.product_id || String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//             saved: p.saved || false,
//           }))
//           .filter((p: Product) => p.image_url?.startsWith('http'));
//         // console.log('🛒 DiscoverCarousel: filtered items count:', items.length);
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         // console.error('🛒 DiscoverCarousel: fetch error:', e.message, e.response?.status);
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   // 🎬 Trigger animations whenever list changes
//   useEffect(() => {
//     fadeAnims.current = recommended.map(() => new Animated.Value(0));
//     translateAnims.current = recommended.map(() => new Animated.Value(20));

//     const anims = recommended.map((_, i) =>
//       Animated.parallel([
//         Animated.timing(fadeAnims.current[i], {
//           toValue: 1,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//         Animated.timing(translateAnims.current[i], {
//           toValue: 0,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//       ]),
//     );

//     Animated.stagger(100, anims).start();

//     return () => {
//       fadeAnims.current.forEach(anim => anim?.stopAnimation?.());
//       translateAnims.current.forEach(anim => anim?.stopAnimation?.());
//     };
//   }, [recommended.length]);

//   // 🪛 Loading & error states
//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <>
//       <ScrollView
//         ref={scrollViewRef}
//         horizontal
//         showsHorizontalScrollIndicator={false}
//         onScrollBeginDrag={handleScrollBeginDrag}
//         onScrollEndDrag={handleScrollEndDrag}
//         onMomentumScrollEnd={handleMomentumScrollEnd}
//         scrollEventThrottle={16}>
//         {recommended.length === 0 ? (
//           <Text style={{padding: 16, color: theme.colors.foreground2}}>
//             No picks found
//           </Text>
//         ) : (
//           displayItems.map((item, i) => (
//             <Animated.View
//               key={item.product_id || item.id || `discover-${i}`}
//               style={{
//                 opacity: fadeAnims.current[i] || new Animated.Value(1),
//                 transform: [
//                   {
//                     translateY:
//                       translateAnims.current[i] || new Animated.Value(0),
//                   },
//                 ],
//               }}>
//               <ScalePressable
//                 style={globalStyles.outfitCard2}
//                 onPress={() => {
//                   if (onOpenItem) {
//                     onOpenItem(item.link, item.title);
//                   } else {
//                     Linking.openURL(item.link || '#');
//                   }
//                 }}>
//                 {/* Image with heart overlay */}
//                 <View style={{position: 'relative', width: '100%'}}>
//                   <Image
//                     source={{uri: item.image_url}}
//                     style={globalStyles.image7}
//                     resizeMode="cover"
//                     onError={() =>
//                       console.warn('⚠️ image failed', item.image_url)
//                     }
//                   />
//                   {/* Heart icon overlay */}
//                   <TouchableOpacity
//                     onPress={e => {
//                       e.stopPropagation();
//                       handleToggleSave(item);
//                     }}
//                     style={{
//                       position: 'absolute',
//                       top: 6,
//                       right: 6,
//                       backgroundColor: 'rgba(0,0,0,0.4)',
//                       borderRadius: 14,
//                       padding: 5,
//                     }}
//                     hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
//                     {savingProductId === item.product_id ? (
//                       <ActivityIndicator size="small" color="#fff" />
//                     ) : (
//                       <MaterialIcons
//                         name={item.saved ? 'favorite' : 'favorite-border'}
//                         size={16}
//                         color={item.saved ? '#ff4d6d' : '#fff'}
//                       />
//                     )}
//                   </TouchableOpacity>
//                 </View>
//                 <Text
//                   style={[
//                     globalStyles.cardLabel,
//                     {
//                       marginHorizontal: 10,
//                       marginTop: 6,
//                     },
//                   ]}
//                   numberOfLines={1}>
//                   {item.title || 'Untitled'}
//                 </Text>
//                 <Text
//                   style={[
//                     globalStyles.cardSubLabel,
//                     {
//                       marginHorizontal: 10,
//                       marginBottom: 8,
//                       marginTop: 4,
//                     },
//                   ]}>
//                   {item.brand || 'Brand'}
//                 </Text>
//               </ScalePressable>
//             </Animated.View>
//           ))
//         )}
//       </ScrollView>
//     </>
//   );
// };

// export default DiscoverCarousel;

////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   Linking,
//   StyleSheet,
//   Animated,
//   Easing,
//   Pressable,
// } from 'react-native';
// import {API_BASE_URL} from '../../config/api';
// import {useUUID} from '../../context/UUIDContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';

// type Product = {
//   id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
// };

// type DiscoverCarouselProps = {
//   onOpenItem?: (url: string, title?: string) => void;
// };

// const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({onOpenItem}) => {
//   const userId = useUUID();
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const fadeAnims = useRef<Animated.Value[]>([]);
//   const translateAnims = useRef<Animated.Value[]>([]);

//   const styles = StyleSheet.create({
//     image: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomColor: theme.colors.surfaceBorder,
//       borderBottomWidth: tokens.borderWidth.md,
//     },
//   });

//   // ⏱️ Initial delay for mount
//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   // 📡 Fetch data
//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         const resp = await fetch(
//           `${API_BASE_URL}/discover/${encodeURIComponent(userId)}`,
//         );
//         if (!resp.ok) throw new Error(`Failed (${resp.status})`);
//         const data = await resp.json();
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//           }))
//           .filter(p => p.image_url?.startsWith('http'));
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   // 🎬 Trigger animations whenever list changes
//   useEffect(() => {
//     fadeAnims.current = recommended.map(() => new Animated.Value(0));
//     translateAnims.current = recommended.map(() => new Animated.Value(20));

//     const anims = recommended.map((_, i) =>
//       Animated.parallel([
//         Animated.timing(fadeAnims.current[i], {
//           toValue: 1,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//         Animated.timing(translateAnims.current[i], {
//           toValue: 0,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//       ]),
//     );

//     Animated.stagger(100, anims).start();

//     return () => {
//       fadeAnims.current.forEach(anim => anim?.stopAnimation?.());
//       translateAnims.current.forEach(anim => anim?.stopAnimation?.());
//     };
//   }, [recommended.length]);

//   // 🪛 Loading & error states
//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//       {recommended.length === 0 ? (
//         <Text style={{padding: 16, color: theme.colors.foreground2}}>
//           No picks found
//         </Text>
//       ) : (
//         recommended.map((item, i) => (
//           <Animated.View
//             key={item.id}
//             style={{
//               opacity: fadeAnims.current[i] || new Animated.Value(1),
//               transform: [
//                 {
//                   translateY:
//                     translateAnims.current[i] || new Animated.Value(0),
//                 },
//               ],
//             }}>
//             <Pressable
//               style={globalStyles.outfitCard2}
//               onPress={() => {
//                 if (onOpenItem) {
//                   onOpenItem(item.link, item.title);
//                 } else {
//                   Linking.openURL(item.link || '#');
//                 }
//               }}>
//               <Image
//                 source={{uri: item.image_url}}
//                 style={globalStyles.image7}
//                 resizeMode="cover"
//                 onError={() => console.warn('⚠️ image failed', item.image_url)}
//               />
//               <Text
//                 style={[
//                   globalStyles.cardLabel,
//                   {
//                     color: theme.colors.foreground,
//                     marginHorizontal: 10,
//                     marginTop: 6,
//                   },
//                 ]}
//                 numberOfLines={1}>
//                 {item.title || 'Untitled'}
//               </Text>
//               <Text
//                 style={[
//                   globalStyles.cardSubLabel,
//                   {
//                     color: theme.colors.foreground2,
//                     marginHorizontal: 10,
//                     marginBottom: 8,
//                     marginTop: 4,
//                   },
//                 ]}>
//                 {item.brand || 'Brand'}
//               </Text>
//             </Pressable>
//           </Animated.View>
//         ))
//       )}
//     </ScrollView>
//   );
// };

// export default DiscoverCarousel;

/////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   Linking,
//   StyleSheet,
//   Animated,
//   Easing,
// } from 'react-native';
// import {API_BASE_URL} from '../../config/api';
// import {useUUID} from '../../context/UUIDContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';

// type Product = {
//   id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
// };

// type DiscoverCarouselProps = {
//   onOpenItem?: (url: string, title?: string) => void;
// };

// const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({onOpenItem}) => {
//   const userId = useUUID();
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const fadeAnims = useRef<Animated.Value[]>([]);
//   const translateAnims = useRef<Animated.Value[]>([]);

//   const styles = StyleSheet.create({
//     card: {
//       width: 160,
//       marginRight: 12,
//       borderRadius: tokens.borderRadius.md,
//       // borderRadius: tokens.borderRadius['2xl'],
//       backgroundColor: theme.colors.surface2,
//       overflow: 'hidden',
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     image: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomColor: theme.colors.surfaceBorder,
//       borderBottomWidth: tokens.borderWidth.md,
//     },
//   });

//   // ⏱️ Initial delay for mount
//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   // 📡 Fetch data
//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         const resp = await fetch(
//           `${API_BASE_URL}/discover/${encodeURIComponent(userId)}`,
//         );
//         if (!resp.ok) throw new Error(`Failed (${resp.status})`);
//         const data = await resp.json();
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//           }))
//           .filter(p => p.image_url?.startsWith('http'));
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   // 🎬 Trigger animations whenever list changes
//   useEffect(() => {
//     fadeAnims.current = recommended.map(() => new Animated.Value(0));
//     translateAnims.current = recommended.map(() => new Animated.Value(20));

//     const anims = recommended.map((_, i) =>
//       Animated.parallel([
//         Animated.timing(fadeAnims.current[i], {
//           toValue: 1,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//         Animated.timing(translateAnims.current[i], {
//           toValue: 0,
//           duration: 450,
//           delay: i * 120,
//           easing: Easing.out(Easing.ease),
//           useNativeDriver: true,
//         }),
//       ]),
//     );

//     Animated.stagger(100, anims).start();

//     return () => {
//       fadeAnims.current.forEach(anim => anim?.stopAnimation?.());
//       translateAnims.current.forEach(anim => anim?.stopAnimation?.());
//     };
//   }, [recommended.length]);

//   // 🪛 Loading & error states
//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//       {recommended.length === 0 ? (
//         <Text style={{padding: 16, color: theme.colors.foreground2}}>
//           No picks found
//         </Text>
//       ) : (
//         recommended.map((item, i) => (
//           <Animated.View
//             key={item.id}
//             style={{
//               opacity: fadeAnims.current[i] || new Animated.Value(1),
//               transform: [
//                 {
//                   translateY:
//                     translateAnims.current[i] || new Animated.Value(0),
//                 },
//               ],
//             }}>
//             <AppleTouchFeedback
//               style={styles.card}
//               hapticStyle="impactLight"
//               onPress={() => {
//                 if (onOpenItem) {
//                   onOpenItem(item.link, item.title);
//                 } else {
//                   Linking.openURL(item.link || '#');
//                 }
//               }}>
//               <Image
//                 source={{uri: item.image_url}}
//                 style={globalStyles.image5}
//                 resizeMode="cover"
//                 onError={() => console.warn('⚠️ image failed', item.image_url)}
//               />
//               <Text
//                 style={[
//                   globalStyles.cardLabel,
//                   {
//                     color: theme.colors.foreground,
//                     marginHorizontal: 10,
//                     marginTop: 6,
//                   },
//                 ]}
//                 numberOfLines={1}>
//                 {item.title || 'Untitled'}
//               </Text>
//               <Text
//                 style={[
//                   globalStyles.cardSubLabel,
//                   {
//                     color: theme.colors.foreground2,
//                     marginHorizontal: 10,
//                     marginBottom: 8,
//                     marginTop: 4,
//                   },
//                 ]}>
//                 {item.brand || 'Brand'}
//               </Text>
//             </AppleTouchFeedback>
//           </Animated.View>
//         ))
//       )}
//     </ScrollView>
//   );
// };

// export default DiscoverCarousel;

///////////////////////

// import React, {useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   Linking,
//   StyleSheet,
// } from 'react-native';
// import {API_BASE_URL} from '../../config/api';
// import {useUUID} from '../../context/UUIDContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';

// type Product = {
//   id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
// };

// type DiscoverCarouselProps = {
//   onOpenItem?: (url: string, title?: string) => void;
// };

// const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({onOpenItem}) => {
//   const userId = useUUID();
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     card: {
//       width: 160,
//       marginRight: 12,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: theme.colors.surface2,
//       overflow: 'hidden',
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     image: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomColor: theme.colors.surfaceBorder,
//       borderBottomWidth: tokens.borderWidth.md,
//     },
//     title: {
//       color: theme.colors.foreground,
//       marginHorizontal: 10,
//       marginTop: 6,
//     },
//     brand: {
//       color: theme.colors.foreground2,
//       marginHorizontal: 10,
//       marginBottom: 8,
//       marginTop: 4,
//     },
//   });

//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         const resp = await fetch(
//           `${API_BASE_URL}/discover/${encodeURIComponent(userId)}`,
//         );
//         if (!resp.ok) throw new Error(`Failed (${resp.status})`);
//         const data = await resp.json();
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//           }))
//           .filter(p => p.image_url?.startsWith('http'));
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//       {recommended.length === 0 ? (
//         <Text style={{padding: 16, color: theme.colors.foreground2}}>
//           No picks found
//         </Text>
//       ) : (
//         recommended.map(item => (
//           <AppleTouchFeedback
//             key={item.id}
//             style={styles.card}
//             hapticStyle="impactLight"
//             onPress={() => {
//               if (onOpenItem) {
//                 onOpenItem(item.link, item.title);
//               } else {
//                 Linking.openURL(item.link || '#');
//               }
//             }}>
//             <Image
//               source={{uri: item.image_url}}
//               style={globalStyles.image5}
//               resizeMode="cover"
//               onError={() => console.warn('⚠️ image failed', item.image_url)}
//             />
//             <Text
//               style={[
//                 globalStyles.cardLabel,
//                 {
//                   color: theme.colors.foreground,
//                   marginHorizontal: 10,
//                   marginTop: 6,
//                 },
//               ]}
//               numberOfLines={1}>
//               {item.title || 'Untitled'}
//             </Text>
//             <Text
//               style={[
//                 globalStyles.cardSubLabel,
//                 {
//                   color: theme.colors.foreground2,
//                   marginHorizontal: 10,
//                   marginBottom: 8,
//                   marginTop: 4,
//                 },
//               ]}>
//               {item.brand || 'Brand'}
//             </Text>
//           </AppleTouchFeedback>
//         ))
//       )}
//     </ScrollView>
//   );
// };

// export default DiscoverCarousel;

//////////////

// import React, {useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   Linking,
//   StyleSheet,
// } from 'react-native';
// import {API_BASE_URL} from '../../config/api';
// import {useUUID} from '../../context/UUIDContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';

// type Product = {
//   id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
// };

// const DiscoverCarousel: React.FC = () => {
//   const userId = useUUID();
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     card: {
//       width: 160,
//       marginRight: 12,
//       borderRadius: 20,
//       backgroundColor: theme.colors.surface2,
//       overflow: 'hidden',
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     image: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomColor: theme.colors.surfaceBorder,
//       borderBottomWidth: tokens.borderWidth.md,
//     },
//     title: {
//       color: theme.colors.foreground,
//       fontSize: 14,
//       fontWeight: '600',
//       marginHorizontal: 8,
//       marginTop: 6,
//     },
//     brand: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginHorizontal: 8,
//       marginBottom: 8,
//       marginTop: 4,
//       fontWeight: '500',
//     },
//   });

//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         const resp = await fetch(
//           `${API_BASE_URL}/discover/${encodeURIComponent(userId)}`,
//         );
//         if (!resp.ok) throw new Error(`Failed (${resp.status})`);
//         const data = await resp.json();
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//           }))
//           .filter(p => p.image_url?.startsWith('http'));
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//       {recommended.length === 0 ? (
//         <Text style={{padding: 16, color: '#666'}}>No picks found</Text>
//       ) : (
//         recommended.map(item => (
//           <AppleTouchFeedback
//             key={item.id}
//             style={styles.card}
//             hapticStyle="impactLight"
//             onPress={() => Linking.openURL(item.link || '#')}>
//             <Image
//               source={{uri: item.image_url}}
//               style={styles.image}
//               resizeMode="cover"
//               onError={() => console.warn('⚠️ image failed', item.image_url)}
//             />
//             <Text style={styles.title} numberOfLines={1}>
//               {item.title || 'Untitled'}
//             </Text>
//             <Text style={styles.brand}>{item.brand || 'Brand'}</Text>
//           </AppleTouchFeedback>
//         ))
//       )}
//     </ScrollView>
//   );
// };

// export default DiscoverCarousel;

///////////////////

// import React, {useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   Linking,
//   StyleSheet,
// } from 'react-native';
// import {API_BASE_URL} from '../config/api';
// import {useUUID} from '../context/UUIDContext';

// type Product = {
//   id: string;
//   title: string;
//   brand: string;
//   image_url: string;
//   link: string;
//   category: string;
// };

// const DiscoverCarousel: React.FC = () => {
//   const userId = useUUID(); // ✅ internal id used everywhere else
//   const [ready, setReady] = useState(false);
//   const [recommended, setRecommended] = useState<Product[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);

//   useEffect(() => {
//     const t = setTimeout(() => setReady(true), 300);
//     return () => clearTimeout(t);
//   }, []);

//   useEffect(() => {
//     if (!ready || !userId) return;
//     (async () => {
//       setLoading(true);
//       try {
//         const resp = await fetch(
//           `${API_BASE_URL}/discover/${encodeURIComponent(userId)}`,
//         );
//         if (!resp.ok) throw new Error(`Failed (${resp.status})`);
//         const data = await resp.json();
//         const items: Product[] = data
//           .map((p: any) => ({
//             id: String(p.id),
//             title: p.title,
//             brand: p.brand,
//             image_url: p.image_url,
//             link: p.link,
//             category: p.category,
//           }))
//           .filter(p => p.image_url?.startsWith('http'));
//         setRecommended(items);
//         setError(null);
//       } catch (e: any) {
//         setError(e.message || 'Failed to load');
//       } finally {
//         setLoading(false);
//       }
//     })();
//   }, [ready, userId]);

//   if (!ready || loading) return <Text style={{padding: 16}}>Loading…</Text>;
//   if (error && recommended.length === 0)
//     return <Text style={{padding: 16}}>{error}</Text>;

//   return (
//     <View style={styles.container}>
//       <Text style={styles.heading}>Discover Picks For You</Text>
//       <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//         {recommended.length === 0 ? (
//           <Text style={{padding: 16, color: '#666'}}>No picks found</Text>
//         ) : (
//           recommended.map(item => (
//             <TouchableOpacity
//               key={item.id}
//               style={styles.card}
//               onPress={() => Linking.openURL(item.link || '#')}>
//               <Image
//                 source={{uri: item.image_url}}
//                 style={styles.image}
//                 resizeMode="cover"
//                 onError={() => console.warn('⚠️ image failed', item.image_url)}
//               />
//               <Text style={styles.title} numberOfLines={1}>
//                 {item.title || 'Untitled'}
//               </Text>
//               <Text style={styles.brand}>{item.brand || 'Brand'}</Text>
//             </TouchableOpacity>
//           ))
//         )}
//       </ScrollView>
//     </View>
//   );
// };

// const styles = StyleSheet.create({
//   container: {marginTop: 24},
//   heading: {
//     fontSize: 18,
//     fontWeight: '600',
//     marginBottom: 12,
//     paddingHorizontal: 16,
//   },
//   card: {
//     width: 160,
//     marginHorizontal: 8,
//     borderRadius: 12,
//     backgroundColor: '#f7f7f7',
//     overflow: 'hidden',
//   },
//   image: {width: '100%', height: 180, backgroundColor: '#ddd'},
//   title: {fontSize: 14, fontWeight: '500', marginHorizontal: 8, marginTop: 6},
//   brand: {fontSize: 12, color: '#666', marginHorizontal: 8, marginBottom: 8},
// });

// export default DiscoverCarousel;
