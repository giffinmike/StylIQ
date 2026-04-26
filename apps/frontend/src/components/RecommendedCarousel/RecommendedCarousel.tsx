import React, {useRef, useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  Animated,
  Easing,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import {useAppTheme} from '../../context/ThemeContext';
import {useUUID} from '../../context/UUIDContext';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {useRecommendedPosts} from '../../hooks/useCommunityApi';
import {apiClient} from '../../lib/apiClient';
import {tokens} from '../../styles/tokens/tokens';
import {isTablet, isLargePhone, isRegularPhone} from '../../styles/global';
import type {CommunityPost} from '../../types/community';

// Card dimensions matching DiscoverCarousel
const CARD_WIDTH = isTablet
  ? 160
  : isLargePhone
    ? 160
    : isRegularPhone
      ? 160
      : 160;
const CARD_HEIGHT = isTablet ? 180 : isLargePhone ? 160 : 160;
const CARD_MARGIN = isTablet ? 16 : isLargePhone ? 10 : 10;
const SCROLL_INTERVAL = CARD_WIDTH + CARD_MARGIN;
const AUTO_SCROLL_DELAY = 8000; // 8 seconds

type RecommendedCarouselProps = {
  onOpenPost: (postId: string) => void;
};

// Animated pressable with scale effect
const ScalePressable = ({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  style?: any;
}) => {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={style}>
      {children}
    </TouchableOpacity>
  );
};

/**
 * Get the display image for a community post.
 * Uses image_url if available, otherwise falls back to top_image.
 */
const getPostImage = (post: CommunityPost): string | null => {
  return post.image_url || post.top_image || null;
};

const RecommendedCarousel: React.FC<RecommendedCarouselProps> = ({
  onOpenPost,
}) => {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const userId = useUUID();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const firedImpressionsRef = useRef<Set<string>>(new Set());
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  const {data: posts, isLoading, error} = useRecommendedPosts(
    userId ?? undefined,
    excludeIds,
  );

  // Track seen post IDs for dedup on subsequent fetches
  useEffect(() => {
    if (posts && posts.length > 0) {
      for (const post of posts) {
        seenIdsRef.current.add(post.id);
      }
    }
  }, [posts]);

  // Impression tracking: fire once per session per post when visible
  const fireImpressions = useCallback(
    (scrollX: number) => {
      if (!posts) return;
      const visible = posts.filter(p => getPostImage(p));
      if (visible.length === 0) return;

      const screenW = Dimensions.get('window').width;
      const startIdx = Math.max(0, Math.floor(scrollX / SCROLL_INTERVAL));
      const endIdx = Math.min(
        visible.length - 1,
        Math.floor((scrollX + screenW) / SCROLL_INTERVAL),
      );

      for (let i = startIdx; i <= endIdx; i++) {
        const post = visible[i];
        if (post && !firedImpressionsRef.current.has(post.id)) {
          firedImpressionsRef.current.add(post.id);
          apiClient
            .post('/community/posts/recommended/impression', {
              postId: post.id,
            })
            .catch(() => {});
        }
      }
    },
    [posts],
  );

  // Fire impressions for initially visible posts
  useEffect(() => {
    if (posts && posts.length > 0) {
      fireImpressions(0);
    }
  }, [posts, fireImpressions]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      fireImpressions(event.nativeEvent.contentOffset.x);
    },
    [fireImpressions],
  );

  // Animation refs
  const fadeAnims = useRef<Animated.Value[]>([]);
  const translateAnims = useRef<Animated.Value[]>([]);

  // Auto-scroll refs
  const scrollViewRef = useRef<ScrollView>(null);
  const currentIndexRef = useRef(0);
  const autoScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isUserScrollingRef = useRef(false);

  // Filter posts with images for counting
  const postsWithImages = posts?.filter(post => getPostImage(post)) || [];

  // Auto-scroll effect - scrolls every 8 seconds
  useEffect(() => {
    if (postsWithImages.length <= 1) return;

    const startAutoScroll = () => {
      autoScrollTimerRef.current = setInterval(() => {
        if (isUserScrollingRef.current) return;

        currentIndexRef.current =
          (currentIndexRef.current + 1) % postsWithImages.length;
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
  }, [postsWithImages.length]);

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

  // Trigger staggered entrance animations when posts load
  useEffect(() => {
    if (!posts || posts.length === 0) return;

    fadeAnims.current = posts.map(() => new Animated.Value(0));
    translateAnims.current = posts.map(() => new Animated.Value(20));

    const anims = posts.map((_, i) =>
      Animated.parallel([
        Animated.timing(fadeAnims.current[i], {
          toValue: 1,
          duration: 450,
          delay: i * 100,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(translateAnims.current[i], {
          toValue: 0,
          duration: 450,
          delay: i * 100,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    Animated.stagger(80, anims).start();

    return () => {
      fadeAnims.current.forEach(anim => anim?.stopAnimation?.());
      translateAnims.current.forEach(anim => anim?.stopAnimation?.());
    };
  }, [posts?.length]);

  const handlePress = useCallback(
    (postId: string) => {
      // ReactNativeHapticFeedback.trigger('impactLight', {
      //   enableVibrateFallback: true,
      //   ignoreAndroidSystemSettings: false,
      // });
      onOpenPost(postId);
    },
    [onOpenPost],
  );

  const styles = StyleSheet.create({
    card: {
      width: CARD_WIDTH,
      marginRight: CARD_MARGIN,
      borderRadius: tokens.borderRadius.sm,
      backgroundColor: theme.colors.surface3,
      overflow: 'hidden',
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.surfaceBorder,
    },
    image: {
      width: '100%',
      height: CARD_HEIGHT - 50,
      backgroundColor: theme.colors.surface,
    },
    infoContainer: {
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    userRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    avatar: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.surface,
      marginRight: 6,
    },
    userName: {
      fontSize: 12,
      color: theme.colors.foreground2,
      fontWeight: '500',
      flex: 1,
    },
    lookName: {
      fontSize: 11,
      color: theme.colors.foreground3,
      fontWeight: '400',
      marginTop: 2,
      paddingLeft: 26, // Align with user name (avatar width + margin)
    },
    loadingContainer: {
      padding: 16,
      alignItems: 'center',
    },
    emptyText: {
      padding: 16,
      color: theme.colors.foreground2,
    },
  });

  // Loading state
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={theme.colors.foreground2} />
      </View>
    );
  }

  // Error state - silently hide carousel
  if (error || !posts || posts.length === 0) {
    return null;
  }

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{paddingRight: 16}}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      scrollEventThrottle={16}>
      {posts.map((post, i) => {
        const imageUrl = getPostImage(post);
        if (!imageUrl) return null; // Skip posts without images

        return (
          <Animated.View
            key={post.id}
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
              style={styles.card}
              onPress={() => handlePress(post.id)}>
              <Image
                source={{uri: imageUrl}}
                style={styles.image}
                resizeMode="cover"
              />
              <View style={styles.infoContainer}>
                <View style={styles.userRow}>
                  {post.user_avatar ? (
                    <Image
                      source={{uri: post.user_avatar}}
                      style={styles.avatar}
                    />
                  ) : (
                    <View style={styles.avatar} />
                  )}
                  <Text style={globalStyles.cardLabel} numberOfLines={1}>
                    {post.user_name || 'User'}
                  </Text>
                </View>
                {post.name && (
                  <Text style={[globalStyles.cardSubLabel,  {
                 
                      marginBottom: 2,
                      marginTop: 4,
                
                    }]} numberOfLines={1}>
                    {post.name}
                  </Text>
                )}
              </View>
            </ScalePressable>
          </Animated.View>
        );
      })}
    </ScrollView>
  );
};

export default RecommendedCarousel;
