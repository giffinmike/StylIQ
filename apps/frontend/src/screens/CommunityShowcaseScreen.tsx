import React, {useState, useRef, useEffect, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
  Easing,
  RefreshControl,
  Modal,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ActivityIndicator,
  Share,
  Alert,
  ScrollView,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {FlashList} from '@shopify/flash-list';
import FastImage from 'react-native-fast-image';
import * as Animatable from 'react-native-animatable';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import LinearGradient from 'react-native-linear-gradient';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

import {useAppTheme} from '../context/ThemeContext';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {fontScale, moderateScale} from '../utils/scale';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import {useUUID} from '../context/UUIDContext';
import {
  useCommunityPosts,
  useSearchPosts,
  useSearchUsers,
  useSavedPosts,
  useLikePost,
  usePostComments,
  useAddComment,
  useDeleteComment,
  useLikeComment,
  useFollowUser,
  useSavePost,
  useBlockUser,
  useUnblockUser,
  useMuteUser,
  useReportPost,
  useDeletePost,
  useUpdatePost,
  useTrackView,
} from '../hooks/useCommunityApi';
import type {CommunityPost, PostComment, PostFilter} from '../types/community';
import {useUnreadCount} from '../hooks/useMessaging';
import Voice from '@react-native-voice/voice';
import {VoiceBus} from '../utils/VoiceUtils/VoiceBus';
import {useShoppingStore} from '../../../../store/shoppingStore';

const {width: SCREEN_WIDTH} = Dimensions.get('window');
const CARD_WIDTH = (SCREEN_WIDTH - 6) / 2;
const CARD_HEIGHT = CARD_WIDTH * 1.3;
const NUM_COLUMNS = 2;

type Props = {
  navigate: (screen: string, params?: any) => void;
  initialPostId?: string;
};

// Layout constants
const BOTTOM_NAV_HEIGHT = 90;
const HEART_ICON_SIZE = 22;
const LIKE_COUNT_SIZE = 12;

// FlashList item types
type FlashListItem =
  | {type: 'hero'; id: string}
  | {type: 'post'; id: string; post: CommunityPost; index: number};

// Helper to get initials from a name
const getInitials = (name: string): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
};

// Helper to check if avatar is a real one (not a pravatar fallback)
const isRealAvatar = (avatarUrl: string | undefined | null): boolean => {
  if (!avatarUrl) return false;
  return !avatarUrl.includes('pravatar.cc');
};

// Helper for Instagram-style relative time
const getRelativeTime = (dateString: string): string => {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffSecs < 60) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 52) return `${diffWeeks}w`;
  return `${Math.floor(diffWeeks / 52)}y`;
};

// Avatar component that shows initials when no real profile picture
const UserAvatar = ({
  avatarUrl,
  userName,
  size,
  style,
  onPress,
}: {
  avatarUrl: string | undefined | null;
  userName: string;
  size: number;
  style?: any;
  onPress?: () => void;
}) => {
  const content = isRealAvatar(avatarUrl) ? (
    <FastImage
      source={{
        uri: avatarUrl!,
        priority: FastImage.priority.normal,
        cache: FastImage.cacheControl.immutable,
      }}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        style,
      ]}
      resizeMode={FastImage.resizeMode.cover}
    />
  ) : (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: '#000',
          justifyContent: 'center',
          alignItems: 'center',
        },
        style,
      ]}>
      <Text
        style={{
          color: '#fff',
          fontSize: size * 0.4,
          fontWeight: '600',
        }}>
        {getInitials(userName)}
      </Text>
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{content}</Pressable>;
  }

  return content;
};

// Mock data for hero fallback
const MOCK_POSTS = [
  {
    id: '1',
    imageUrl:
      'https://images.unsplash.com/photo-1507680434567-5739c80be1ac?w=400',
    userName: 'StyleQueen',
    userAvatar: 'https://i.pravatar.cc/100?img=1',
    likes: 234,
    views: 1247,
    tags: ['casual', 'summer'],
  },
  {
    id: '2',
    imageUrl:
      'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=400',
    userName: 'FashionForward',
    userAvatar: 'https://i.pravatar.cc/100?img=2',
    likes: 189,
    views: 892,
    tags: ['elegant', 'evening'],
  },
  {
    id: '3',
    imageUrl:
      'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=400',
    userName: 'TrendSetter',
    userAvatar: 'https://i.pravatar.cc/100?img=3',
    likes: 421,
    views: 2156,
    tags: ['streetwear', 'urban'],
  },
];

const h = (
  type:
    | 'selection'
    | 'impactLight'
    | 'impactMedium'
    | 'impactHeavy'
    | 'notificationSuccess'
    | 'notificationWarning'
    | 'notificationError',
) =>
  ReactNativeHapticFeedback.trigger(type, {
    enableVibrateFallback: true,
    ignoreAndroidSystemSettings: false,
  });

export default function CommunityShowcaseScreen({navigate, initialPostId}: Props) {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const insets = useSafeAreaInsets();
  const userId = useUUID() || undefined;

  // Unread messages count
  const {data: unreadCount = 0} = useUnreadCount(userId || '');

  // Filter state
  const [activeFilter, setActiveFilter] = useState<PostFilter>('all');
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  // API hooks
  const {
    data: posts = [],
    isLoading: isLoadingPosts,
    refetch: refetchPosts,
    isRefetching: isRefetchingPosts,
  } = useCommunityPosts(userId, activeFilter, 100);

  const {
    data: savedPosts = [],
    isLoading: isLoadingSaved,
    refetch: refetchSaved,
    isRefetching: isRefetchingSaved,
  } = useSavedPosts(100);

  const {data: searchResults = []} = useSearchPosts(searchQuery, userId);
  const {data: userSearchResults} = useSearchUsers(searchQuery);

  const likeMutation = useLikePost();
  const saveMutation = useSavePost();
  const followMutation = useFollowUser();
  const blockMutation = useBlockUser();
  const unblockMutation = useUnblockUser();
  const muteMutation = useMuteUser();
  const reportMutation = useReportPost();
  const deletePostMutation = useDeletePost();
  const updatePostMutation = useUpdatePost();
  const addCommentMutation = useAddComment();
  const deleteCommentMutation = useDeleteComment();
  const trackViewMutation = useTrackView();
  const likeCommentMutation = useLikeComment();

  // Tracking consent from shopping store
  const trackingConsent = useShoppingStore(state => state.trackingConsent);

  // Combine loading and refetching states
  const isLoading = activeFilter === 'saved' ? isLoadingSaved : isLoadingPosts;
  const isRefetching =
    activeFilter === 'saved' ? isRefetchingSaved : isRefetchingPosts;
  const refetch = activeFilter === 'saved' ? refetchSaved : refetchPosts;

  // Derive displayed posts from API data
  const activePosts = activeFilter === 'saved' ? savedPosts : posts;
  const displayedPosts: CommunityPost[] =
    searchQuery.length > 0 ? searchResults : activePosts;

  // Local UI state for blocks and mutes
  const [blockedUsers, setBlockedUsers] = useState<Set<string>>(new Set());
  const [mutedUsers, setMutedUsers] = useState<Set<string>>(new Set());

  // Track user's follow actions locally (persists until component unmounts)
  const [userFollows, setUserFollows] = useState<Map<string, boolean>>(
    new Map(),
  );

  // Comments state
  const [commentsModalVisible, setCommentsModalVisible] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [replyingTo, setReplyingTo] = useState<{
    id: string;
    user: string;
  } | null>(null);

  // Fetch comments for active post
  const {data: commentsData = [], refetch: refetchComments} = usePostComments(
    activePostId || '',
    userId,
  );

  // Actions modal state (Pinterest-style)
  const [actionsModalVisible, setActionsModalVisible] = useState(false);
  const [activeActionsPost, setActiveActionsPost] =
    useState<CommunityPost | null>(null);

  // Post detail modal state (social media exploded view)
  const [postDetailModalVisible, setPostDetailModalVisible] = useState(false);
  const [detailPost, setDetailPost] = useState<CommunityPost | null>(null);
  const postDetailSlideAnim = useRef(new Animated.Value(0)).current;
  const postDetailOpacityAnim = useRef(new Animated.Value(0)).current;

  // Open post detail modal with animation
  const openPostDetailModal = useCallback(
    (post: CommunityPost) => {
      // h('impactLight');
      setDetailPost(post);
      setPostDetailModalVisible(true);
      // Track view only if user consented to tracking
      if (trackingConsent === 'accepted') {
        trackViewMutation.mutate({postId: post.id});
      }
      // Animate in
      Animated.parallel([
        Animated.spring(postDetailSlideAnim, {
          toValue: 1,
          damping: 20,
          stiffness: 300,
          mass: 0.8,
          useNativeDriver: true,
        }),
        Animated.timing(postDetailOpacityAnim, {
          toValue: 1,
          duration: 250,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    },
    [
      postDetailSlideAnim,
      postDetailOpacityAnim,
      trackViewMutation,
      trackingConsent,
    ],
  );

  // Close post detail modal with animation
  const closePostDetailModal = useCallback(() => {
    h('selection');
    Animated.parallel([
      Animated.timing(postDetailSlideAnim, {
        toValue: 0,
        duration: 280,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(postDetailOpacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setPostDetailModalVisible(false);
      setDetailPost(null);
    });
  }, [postDetailSlideAnim, postDetailOpacityAnim]);

  // Open initial post modal if navigated with initialPostId
  const lastOpenedPostIdRef = useRef<string | null>(null);
  useEffect(() => {
    // console.log('[CommunityShowcase] initialPostId:', initialPostId, 'posts.length:', posts.length, 'lastOpened:', lastOpenedPostIdRef.current);
    if (initialPostId && posts.length > 0 && lastOpenedPostIdRef.current !== initialPostId) {
      const targetPost = posts.find((p: CommunityPost) => p.id === initialPostId);
      // console.log('[CommunityShowcase] targetPost found:', !!targetPost);
      if (targetPost) {
        lastOpenedPostIdRef.current = initialPostId;
        // Open immediately - no delay needed
        openPostDetailModal(targetPost);
      }
    }
  }, [initialPostId, posts, openPostDetailModal]);

  // Animated search toggle
  const toggleSearch = () => {
    if (showSearch) {
      // Close search
      Animated.timing(searchAnim, {
        toValue: 0,
        duration: 350,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false,
      }).start(() => {
        setShowSearch(false);
        setSearchQuery('');
      });
    } else {
      // Open search - slower, sleek slide
      setShowSearch(true);
      Animated.timing(searchAnim, {
        toValue: 1,
        duration: 750,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        useNativeDriver: false,
      }).start(() => {
        searchInputRef.current?.focus();
      });
    }
    h('selection');
  };

  // Track user's like/save actions locally (persists until component unmounts)
  const [userLikedPosts, setUserLikedPosts] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [userSavedPosts, setUserSavedPosts] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [userLikedComments, setUserLikedComments] = useState<
    Map<string, boolean>
  >(new Map());

  // Check if post is liked - local override takes precedence
  const isPostLiked = useCallback(
    (post: CommunityPost) => {
      if (userLikedPosts.has(post.id)) {
        return userLikedPosts.get(post.id)!;
      }
      return post.is_liked_by_me;
    },
    [userLikedPosts],
  );

  // Check if post is saved - local override takes precedence
  const isPostSaved = useCallback(
    (post: CommunityPost) => {
      if (userSavedPosts.has(post.id)) {
        return userSavedPosts.get(post.id)!;
      }
      return post.is_saved_by_me;
    },
    [userSavedPosts],
  );

  // Check if comment is liked - local override takes precedence
  const isCommentLiked = useCallback(
    (comment: PostComment) => {
      if (userLikedComments.has(comment.id)) {
        return userLikedComments.get(comment.id)!;
      }
      return comment.is_liked_by_me;
    },
    [userLikedComments],
  );

  // Get displayed like count for a post, accounting for local state changes
  const getPostLikeCount = useCallback(
    (post: CommunityPost) => {
      const originallyLiked = post.is_liked_by_me;
      const currentlyLiked = isPostLiked(post);
      // If state changed, adjust the count
      if (currentlyLiked && !originallyLiked) {
        return post.likes_count + 1;
      }
      if (!currentlyLiked && originallyLiked) {
        return Math.max(0, post.likes_count - 1);
      }
      return post.likes_count;
    },
    [isPostLiked],
  );

  // Get displayed like count for a comment, accounting for local state changes
  const getCommentLikeCount = useCallback(
    (comment: PostComment) => {
      const originallyLiked = comment.is_liked_by_me;
      const currentlyLiked = isCommentLiked(comment);
      // If state changed, adjust the count
      if (currentlyLiked && !originallyLiked) {
        return comment.likes_count + 1;
      }
      if (!currentlyLiked && originallyLiked) {
        return Math.max(0, comment.likes_count - 1);
      }
      return comment.likes_count;
    },
    [isCommentLiked],
  );

  // Toggle like - store user's intent locally, fire API in background
  const toggleLike = useCallback(
    (post: CommunityPost) => {
      h('impactLight');
      const currentlyLiked = isPostLiked(post);
      const newLikedState = !currentlyLiked;

      // Update local state immediately
      setUserLikedPosts(prev => {
        const next = new Map(prev);
        next.set(post.id, newLikedState);
        return next;
      });

      // API call (fire and forget - local state is source of truth for UI)
      if (userId) {
        likeMutation.mutate({postId: post.id, isLiked: currentlyLiked});
      }
    },
    [isPostLiked, likeMutation, userId],
  );

  // Check if user is following post author - local override takes precedence
  const isFollowingAuthor = useCallback(
    (post: CommunityPost) => {
      if (userFollows.has(post.user_id)) {
        return userFollows.get(post.user_id)!;
      }
      return post.is_following_author;
    },
    [userFollows],
  );

  // Toggle follow - store user's intent locally, fire API in background
  const toggleFollow = useCallback(
    (post: CommunityPost) => {
      h('impactLight');
      const currentlyFollowing = isFollowingAuthor(post);
      const newFollowState = !currentlyFollowing;

      // Update local state immediately
      setUserFollows(prev => {
        const next = new Map(prev);
        next.set(post.user_id, newFollowState);
        return next;
      });

      // API call (fire and forget - local state is source of truth for UI)
      if (userId) {
        followMutation.mutate({
          targetUserId: post.user_id,
          isFollowing: currentlyFollowing,
        });
      }
    },
    [followMutation, isFollowingAuthor, userId],
  );

  const openComments = (postId: string) => {
    h('selection');
    setActivePostId(postId);
    setCommentsModalVisible(true);
  };

  const openActionsModal = (post: CommunityPost) => {
    h('selection');
    setActiveActionsPost(post);
    setActionsModalVisible(true);
    // Track view when user opens post details (only if consented)
    if (trackingConsent === 'accepted') {
      trackViewMutation.mutate({postId: post.id});
    }
  };

  // Add comment via API
  const handleAddComment = useCallback(() => {
    if (!newComment.trim() || !activePostId || !userId) {
      return;
    }
    h('impactLight');

    addCommentMutation.mutate(
      {
        postId: activePostId,
        content: replyingTo
          ? `@${replyingTo.user} ${newComment.trim()}`
          : newComment.trim(),
        replyToId: replyingTo?.id,
        replyToUser: replyingTo?.user,
      },
      {
        onSuccess: () => {
          setNewComment('');
          setReplyingTo(null);
          refetchComments();
        },
      },
    );
  }, [
    newComment,
    activePostId,
    replyingTo,
    addCommentMutation,
    refetchComments,
    userId,
  ]);

  // Delete comment via API
  const handleDeleteComment = useCallback(
    (postId: string, commentId: string) => {
      if (!userId) return;
      h('impactMedium');
      deleteCommentMutation.mutate(
        {postId, commentId},
        {
          onSuccess: () => {
            refetchComments();
          },
        },
      );
    },
    [deleteCommentMutation, refetchComments, userId],
  );

  // Toggle save/bookmark post - store user's intent locally, fire API in background
  const toggleSavePost = useCallback(
    (post: CommunityPost) => {
      h('impactLight');
      const currentlySaved = isPostSaved(post);
      const newSavedState = !currentlySaved;

      // Update local state immediately
      setUserSavedPosts(prev => {
        const next = new Map(prev);
        next.set(post.id, newSavedState);
        return next;
      });

      // API call (fire and forget - local state is source of truth for UI)
      if (userId) {
        saveMutation.mutate({postId: post.id, isSaved: currentlySaved});
      }
    },
    [isPostSaved, saveMutation, userId],
  );

  // Block/unblock user via API
  const handleBlockUser = useCallback(
    (post: CommunityPost) => {
      if (!userId) return;
      h('impactMedium');
      const isBlocked = blockedUsers.has(post.user_id);

      // Update local state immediately
      setBlockedUsers(prev => {
        const next = new Set(prev);
        if (next.has(post.user_id)) {
          next.delete(post.user_id);
        } else {
          next.add(post.user_id);
        }
        return next;
      });

      // Fire API call in background
      if (isBlocked) {
        unblockMutation.mutate({
          targetUserId: post.user_id,
        });
      } else {
        blockMutation.mutate({
          targetUserId: post.user_id,
        });
      }
    },
    [blockMutation, unblockMutation, blockedUsers, userId],
  );

  // Mute user via API
  const handleMuteUser = useCallback(
    (post: CommunityPost) => {
      if (!userId) return;
      h('impactLight');
      const isMuted = mutedUsers.has(post.user_id);

      setMutedUsers(prev => {
        const next = new Set(prev);
        if (next.has(post.user_id)) {
          next.delete(post.user_id);
        } else {
          next.add(post.user_id);
        }
        return next;
      });

      muteMutation.mutate({
        targetUserId: post.user_id,
        isMuted,
      });
    },
    [muteMutation, mutedUsers, userId],
  );

  // Report post
  const handleReportPost = useCallback(
    (post: CommunityPost) => {
      if (!userId) return;
      h('impactMedium');
      reportMutation.mutate({
        postId: post.id,
        userId,
        reason: 'Reported by user',
      });
      setActionsModalVisible(false);
    },
    [reportMutation, userId],
  );

  // Delete own post
  const handleDeletePost = useCallback(
    (post: CommunityPost) => {
      if (!userId || post.user_id !== userId) return;
      h('impactMedium');
      Alert.alert(
        'Delete Post',
        'Are you sure you want to delete this post? This action cannot be undone.',
        [
          {
            text: 'Cancel',
            style: 'cancel',
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              deletePostMutation.mutate(
                {postId: post.id, userId},
                {
                  onSuccess: () => {
                    refetch();
                  },
                },
              );
            },
          },
        ],
      );
    },
    [deletePostMutation, userId, refetch],
  );

  // Edit own post state
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingPost, setEditingPost] = useState<CommunityPost | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editTags, setEditTags] = useState('');
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const descriptionBeforeVoiceRef = useRef('');

  // Voice input handlers for Story field
  const startVoiceInput = useCallback(async () => {
    try {
      descriptionBeforeVoiceRef.current = editDescription;
      setIsVoiceRecording(true);

      Voice.onSpeechPartialResults = (e: {value?: string[]}) => {
        if (e.value && e.value[0]) {
          const base = descriptionBeforeVoiceRef.current;
          setEditDescription(base ? `${base} ${e.value[0]}` : e.value[0]);
        }
      };
      Voice.onSpeechResults = (e: {value?: string[]}) => {
        if (e.value && e.value[0]) {
          const base = descriptionBeforeVoiceRef.current;
          setEditDescription(base ? `${base} ${e.value[0]}` : e.value[0]);
        }
      };
      Voice.onSpeechEnd = () => {
        setIsVoiceRecording(false);
        VoiceBus.reset();
      };
      Voice.onSpeechError = () => {
        setIsVoiceRecording(false);
        VoiceBus.reset();
      };
      await Voice.start('en-US');
      // Immediately suppress the global voice overlay
      VoiceBus.reset();
    } catch (err) {
      console.warn('Voice start error:', err);
      setIsVoiceRecording(false);
    }
  }, [editDescription]);

  const stopVoiceInput = useCallback(async () => {
    try {
      await Voice.stop();
      setIsVoiceRecording(false);
      VoiceBus.reset();
    } catch (err) {
      console.warn('Voice stop error:', err);
      setIsVoiceRecording(false);
      VoiceBus.reset();
    }
  }, []);

  const handleOpenEditModal = useCallback((post: CommunityPost) => {
    setEditingPost(post);
    setEditName(post.name || '');
    setEditDescription(post.description || '');
    setEditTags((post.tags || []).join(', '));
    setEditModalVisible(true);
    setActionsModalVisible(false);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!userId || !editingPost) return;
    h('impactLight');
    const tagsArray = editTags
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0);
    updatePostMutation.mutate(
      {
        postId: editingPost.id,
        userId,
        name: editName,
        description: editDescription,
        tags: tagsArray,
      },
      {
        onSuccess: () => {
          setEditModalVisible(false);
          setEditingPost(null);
          refetch();
        },
      },
    );
  }, [
    updatePostMutation,
    userId,
    editingPost,
    editName,
    editDescription,
    editTags,
    refetch,
  ]);

  // Like a comment - optimistic update
  const handleToggleLikeComment = useCallback(
    (postId: string, comment: PostComment) => {
      if (!userId) return;
      h('impactLight');

      const currentlyLiked = isCommentLiked(comment);
      const newLikedState = !currentlyLiked;

      // Update local state immediately for instant feedback
      setUserLikedComments(prev => {
        const next = new Map(prev);
        next.set(comment.id, newLikedState);
        return next;
      });

      // API call in background
      likeCommentMutation.mutate(
        {
          commentId: comment.id,
          postId,
          isLiked: currentlyLiked,
        },
        {
          onSuccess: () => {
            refetchComments();
          },
        },
      );
    },
    [likeCommentMutation, refetchComments, userId, isCommentLiked],
  );

  // Reply to a comment
  const startReply = (commentId: string, userName: string) => {
    h('selection');
    setReplyingTo({id: commentId, user: userName});
  };

  const cancelReply = () => {
    setReplyingTo(null);
  };

  // Handle tag tap - opens search with that tag
  const handleTagTap = useCallback(
    (tag: string) => {
      h('selection');
      setSearchQuery(tag);
      if (!showSearch) {
        setShowSearch(true);
        Animated.timing(searchAnim, {
          toValue: 1,
          duration: 450,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          useNativeDriver: false,
        }).start(() => {
          searchInputRef.current?.focus();
        });
      }
    },
    [showSearch, searchAnim],
  );

  // Share post via iOS Share Sheet
  const handleSharePost = useCallback(async (post: CommunityPost) => {
    h('selection');
    try {
      const imageUrl = post.image_url || post.top_image || '';
      // Only allow https URLs to prevent javascript:/data:/etc injection
      const safeUrl = imageUrl.toLowerCase().startsWith('https://')
        ? imageUrl
        : undefined;
      await Share.share({
        message: `Check out this outfit on StylHelpr! ${post.description || ''}`,
        url: safeUrl,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  }, []);

  // Scroll tracking for bottom nav hide/show
  const scrollY = useRef(new Animated.Value(0)).current;
  const flashListRef = useRef<any>(null);

  // Handle scroll event for bottom nav hide/show
  const handleScroll = useCallback(
    (event: {nativeEvent: {contentOffset: {y: number}}}) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      scrollY.setValue(offsetY);
      if ((global as any).__navScrollY) {
        (global as any).__navScrollY.setValue(offsetY);
      }
    },
    [scrollY],
  );

  // Screen entrance animation
  const screenFade = useRef(new Animated.Value(0)).current;
  const screenTranslate = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(screenFade, {
        toValue: 1,
        duration: 400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(screenTranslate, {
        toValue: 0,
        duration: 450,
        easing: Easing.out(Easing.exp),
        useNativeDriver: true,
      }),
    ]).start();
  }, [screenFade, screenTranslate]);

  // Auto-cycle through user share images with fade transition timed with text animation
  useEffect(() => {
    const interval = setInterval(() => {
      // Fade out
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 800,
        useNativeDriver: true,
      }).start(() => {
        setCurrentImageIndex(prev => (prev + 1) % MOCK_POSTS.length);
        // Fade in (timing: 200ms delay + 1200ms animation = 1400ms total, coincides with text fadeInUp)
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }).start();
      });
    }, 8000);
    return () => clearInterval(interval);
  }, [fadeAnim]);

  const onRefresh = async () => {
    h('impactLight');
    await refetch();
  };

  const filters: PostFilter[] = [
    'all',
    'foryou',
    'trending',
    'new',
    'following',
    'saved',
  ];

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      paddingHorizontal: moderateScale(tokens.spacing.md1),
      paddingTop: insets.top + 60,
      paddingBottom: moderateScale(tokens.spacing.sm),
    },
    headerTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerSubtitle: {
      fontSize: fontScale(14),
      fontWeight: '500',
      color: theme.colors.secondary,
      marginTop: moderateScale(4),
    },
    gridContainer: {
      paddingHorizontal: moderateScale(tokens.spacing.nano),
      paddingBottom: insets.bottom + BOTTOM_NAV_HEIGHT + 20,
    },
    card: {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      marginBottom: moderateScale(tokens.spacing.md),
      // borderRadius: tokens.borderRadius.sm,
      overflow: 'hidden',
    },
    cardImage: {
      width: '100%',
      height: '100%',
    },
    cardOverlayContainer: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 150,
      justifyContent: 'flex-end',
    },
    cardGradient: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: -1,
      // borderBottomLeftRadius: tokens.borderRadius.sm,
      // borderBottomRightRadius: tokens.borderRadius.sm,
    },
    cardContent: {
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    cardUserRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 3,
    },
    cardAvatar: {
      width: 35,
      height: 35,
      borderRadius: 50,
      marginRight: 8,
      borderWidth: 1.5,
      borderColor: theme.colors.button1,
    },
    cardUserName: {
      fontSize: fontScale(tokens.fontSize.sm),
      fontWeight: tokens.fontWeight.normal,
      color: theme.colors.buttonText1,
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: {width: 0, height: 1},
      textShadowRadius: 2,
      flex: 1,
      flexShrink: 1,
    },
    cardActions: {
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 2,
    },
    actionButtonsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
    },
    cardTags: {
      flexDirection: 'row',
      gap: 4,
      flexWrap: 'wrap',
    },
    cardTag: {
      fontSize: fontScale(tokens.fontSize.xs),
      color: 'rgba(255,255,255,0.85)',
      backgroundColor: 'rgba(59, 59, 59, 0.7)',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: 'hidden',
    },
    likeButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 4,
    },
    likeCount: {
      fontSize: LIKE_COUNT_SIZE,
      fontWeight: tokens.fontWeight.normal,
      color: theme.colors.buttonText1,
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: {width: 0, height: 1},
      textShadowRadius: 2,
    },
    moreButton: {
      padding: 4,
      marginLeft: 6,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 60,
    },
    emptyIcon: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: theme.colors.pillDark1,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: moderateScale(tokens.spacing.md),
    },
    emptyTitle: {
      fontSize: fontScale(tokens.fontSize.lg),
      fontWeight: tokens.fontWeight.bold,
      color: theme.colors.foreground,
      marginBottom: 8,
    },
    emptySubtitle: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.muted,
      textAlign: 'center',
      paddingHorizontal: 40,
    },
    ctaButton: {
      marginTop: moderateScale(tokens.spacing.lg),
      backgroundColor: theme.colors.button1,
      paddingHorizontal: moderateScale(tokens.spacing.lg),
      paddingVertical: moderateScale(tokens.spacing.sm),
      borderRadius: tokens.borderRadius.sm,
    },
    ctaText: {
      fontSize: fontScale(tokens.fontSize.sm),
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.buttonText1,
    },
    // Search styles
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: 20,
      paddingHorizontal: 14,
      marginHorizontal: moderateScale(tokens.spacing.md1),
      marginBottom: moderateScale(tokens.spacing.sm),
      height: 42,
    },
    searchInput: {
      flex: 1,
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.foreground,
      marginLeft: 10,
      paddingVertical: 0,
    },
    searchIcon: {
      padding: 4,
      position: 'relative',
      marginLeft: 20,
    },
    unreadBadge: {
      position: 'absolute',
      top: -2,
      right: -2,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: '#FF4D6D',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
    },
    unreadBadgeText: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '700',
    },
    filtersContainer: {
      paddingHorizontal: moderateScale(tokens.spacing.md),
      marginBottom: moderateScale(tokens.spacing.md),
    },
    filtersScroll: {
      flexDirection: 'row',
      gap: 10,
    },
    filterPill: {
      paddingHorizontal: moderateScale(tokens.spacing.md),
      paddingVertical: moderateScale(tokens.spacing.xs),
      borderRadius: tokens.borderRadius.sm,
      borderWidth: 1,
      borderColor: theme.colors.muted,
    },
    filterPillActive: {
      backgroundColor: theme.colors.button1,
    },
    filterText: {
      fontSize: 12,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.foreground,
      textTransform: 'capitalize',
    },
    filterTextActive: {
      color: theme.colors.buttonText1,
      fontWeight: tokens.fontWeight.semiBold,
    },
    // Follow button styles
    followButton: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      backgroundColor: 'transparent',
      marginLeft: 6,
      borderWidth: 1,
      borderColor: theme.colors.buttonText1,
    },
    followButtonFollowing: {
      backgroundColor: theme.colors.button1,
      borderColor: theme.colors.muted,
      borderWidth: tokens.borderWidth.hairline,
    },
    followButtonText: {
      fontSize: 10,
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    // Comments modal styles
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    commentsModal: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      height: '70%',
      paddingTop: 12,
    },
    modalHandle: {
      width: 40,
      height: 4,
      backgroundColor: theme.colors.muted,
      borderRadius: 2,
      alignSelf: 'center',
      marginBottom: 12,
    },
    commentsHeader: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surface,
    },
    commentsTitle: {
      fontSize: fontScale(tokens.fontSize.md),
      fontWeight: tokens.fontWeight.bold,
      color: theme.colors.foreground,
    },
    commentsList: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
    },
    commentItem: {
      flexDirection: 'row',
      marginBottom: 20,
      alignItems: 'flex-start',
    },
    commentAvatar: {
      marginRight: 12,
    },
    commentContent: {
      flex: 1,
      paddingRight: 8,
    },
    commentHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 2,
    },
    commentUser: {
      fontSize: fontScale(tokens.fontSize.sm),
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    commentText: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.foreground,
      lineHeight: fontScale(tokens.fontSize.sm) * 1.4,
      marginBottom: 6,
    },
    commentTime: {
      fontSize: fontScale(12),
      color: theme.colors.muted,
    },
    commentMention: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: '#3897f0',
      fontWeight: tokens.fontWeight.medium,
    },
    commentLikesCount: {
      fontSize: fontScale(13),
      color: theme.colors.foreground,
      marginTop: 2,
    },
    commentReplyButton: {
      fontSize: fontScale(13),
      color: theme.colors.muted,
      fontWeight: tokens.fontWeight.semiBold,
    },
    commentLikeContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: 12,
      paddingTop: 4,
      gap: 12,
    },
    replyingToContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: theme.colors.surface,
    },
    replyingToText: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.muted,
    },
    commentInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.surface,
      paddingBottom: insets.bottom + 10,
      backgroundColor: theme.colors.surface,
    },
    commentInput: {
      flex: 1,
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.foreground,
      paddingVertical: 8,
      maxHeight: 100,
    },
    postButton: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.primary,
      fontWeight: tokens.fontWeight.bold,
    },
    postButtonDisabled: {
      opacity: 0.4,
    },
    // Actions modal styles
    actionsModal: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 12,
      paddingBottom: insets.bottom + 20,
      maxHeight: '85%',
    },
    actionsUserRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surface,
    },
    actionsAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      marginRight: 12,
    },
    actionsUserInfo: {
      flex: 1,
    },
    actionsUserName: {
      fontSize: fontScale(tokens.fontSize.base),
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    actionsUserHandle: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.muted,
      marginTop: 2,
    },
    actionsList: {
      paddingTop: 8,
    },
    actionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    actionIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 14,
    },
    actionText: {
      fontSize: fontScale(tokens.fontSize.base),
      color: theme.colors.foreground,
      flex: 1,
    },
    actionChevron: {
      opacity: 0.4,
    },
    editLabel: {
      fontSize: fontScale(tokens.fontSize.sm),
      marginBottom: moderateScale(tokens.spacing.xs),
      marginTop: moderateScale(tokens.spacing.sm),
    },
    editInput: {
      borderWidth: 1,
      borderRadius: 12,
      padding: moderateScale(tokens.spacing.sm),
      fontSize: fontScale(tokens.fontSize.base),
      minHeight: 80,
      textAlignVertical: 'top',
    },
    // Post detail modal styles
    postDetailOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.95)',
    },
    postDetailContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    postDetailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: insets.top + 8,
      paddingBottom: 12,
      backgroundColor: theme.colors.background,
    },
    postDetailCloseButton: {
      width: 35,
      height: 35,
      backgroundColor: 'white',
      borderRadius: 20,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 16,
      marginLeft: 20,
    },
    postDetailUserInfo: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: 12,
    },
    postDetailAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: 10,
      borderWidth: 2,
      borderColor: theme.colors.button1,
    },
    postDetailUserName: {
      fontSize: fontScale(tokens.fontSize.base),
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    postDetailHandle: {
      fontSize: fontScale(tokens.fontSize.xs),
      color: theme.colors.foreground,
      marginTop: 1,
    },
    postDetailFollowButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: theme.colors.muted,
    },
    postDetailFollowButtonFollowing: {
      backgroundColor: theme.colors.button1,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.4)',
    },
    postDetailFollowText: {
      fontSize: fontScale(tokens.fontSize.sm),
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.buttonText1,
    },
    postDetailImageContainer: {
      justifyContent: 'flex-start',
      alignItems: 'center',
      // paddingVertical: 4,
      backgroundColor: theme.colors.imageBackground
    },
    postDetailImage: {
      width: SCREEN_WIDTH - 3,
      height: SCREEN_WIDTH * 1.28,
      // borderRadius: 16,
    },
    postDetailCompositeContainer: {
      width: SCREEN_WIDTH - 16,
      height: SCREEN_WIDTH - 16,
      borderRadius: 16,
      overflow: 'hidden',
    },
    postDetailCompositeCell: {
      backgroundColor: '#F5F5F5',
    },
    postDetailFooter: {
      paddingHorizontal: 16,
      paddingBottom: insets.bottom + 20,
      paddingTop: 4,
    },
    postDetailActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    postDetailActionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 4,
    },
    postDetailActionText: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.foreground,
      marginLeft: 6,
      fontWeight: tokens.fontWeight.medium,
    },
    postDetailRightActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    postDetailStats: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    postDetailStat: {
      fontSize: fontScale(tokens.fontSize.md),
      color: theme.colors.foreground,
      fontWeight: '500',
    },
    postDetailTitle: {
      fontSize: fontScale(tokens.fontSize.lg),
      fontWeight: tokens.fontWeight.bold,
      color: theme.colors.foreground,
      marginBottom: 12,
    },
    postDetailTagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    postDetailTag: {
      fontSize: fontScale(tokens.fontSize.sm),
      color: theme.colors.foreground,
      backgroundColor: 'rgba(255,255,255,0.15)',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
      overflow: 'hidden',
    },
    postDetailStory: {
      fontSize: fontScale(tokens.fontSize.base),
      color: theme.colors.foreground,
      lineHeight: 22,
      marginTop: 12,
    },
  });

  // Build FlashList data with hero header
  const flashListData = useMemo((): FlashListItem[] => {
    const result: FlashListItem[] = [];

    // Add hero as first item
    result.push({type: 'hero', id: 'hero-section'});

    // Add all posts
    displayedPosts.forEach((post, index) => {
      result.push({type: 'post', id: post.id, post, index});
    });

    return result;
  }, [displayedPosts]);

  // Render hero section
  const renderHeroSection = useCallback(() => {
    const heroPost =
      displayedPosts.length > 0
        ? displayedPosts[currentImageIndex % displayedPosts.length]
        : null;
    const mockPost = MOCK_POSTS[currentImageIndex % MOCK_POSTS.length];
    const heroImageUrl = heroPost?.image_url || heroPost?.top_image || mockPost.imageUrl;
    const heroUserName = heroPost?.user_name || mockPost.userName;
    const heroUserAvatar = heroPost?.user_avatar || mockPost.userAvatar;
    const heroUserId = heroPost?.user_id;
    const heroTags = heroPost?.tags || mockPost.tags;
    const heroLikes = heroPost ? getPostLikeCount(heroPost) : mockPost.likes;
    const heroViews = heroPost?.views_count ?? mockPost.views ?? 0;
    const heroName = heroPost?.name || heroPost?.description || 'Featured Look';

    return (
      <Pressable
        onPress={() => {
          if (heroPost) {
            openPostDetailModal(heroPost);
          }
        }}
        style={{
          width: '100%',
          height: 300,
          overflow: 'hidden',
          marginBottom: 14,
        }}>
        <Animated.View
          style={{
            width: '100%',
            height: '100%',
            borderRadius: tokens.borderRadius.lg,
            opacity: fadeAnim,
          }}>
          <FastImage
            source={{
              uri: heroImageUrl,
              priority: FastImage.priority.high,
              cache: FastImage.cacheControl.immutable,
            }}
            style={{
              width: '100%',
              height: '100%',
              // borderRadius: tokens.borderRadius.lg,
              backgroundColor: theme.colors.imageBackground,
            }}
            resizeMode={FastImage.resizeMode.contain}
          />
        </Animated.View>

        {/* Light tinted overlay for better text visibility */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            // borderRadius: tokens.borderRadius.lg,
          }}
        />

        {/* Title in upper left corner */}
        <View
          style={{
            position: 'absolute',
            top: moderateScale(tokens.spacing.md),
            left: moderateScale(tokens.spacing.md),
          }}>
          <Text
            style={{
              fontSize: fontScale(tokens.fontSize['3xl']),
              fontWeight: tokens.fontWeight.bold,
              color: 'white',
              textShadowColor: 'rgba(0, 0, 0, 1)',
              textShadowOffset: {width: 0, height: 1},
              textShadowRadius: 3,
            }}>
            "{heroName}"
          </Text>
        </View>

        <Animatable.View
          key={`text-${currentImageIndex}`}
          animation="fadeInUp"
          duration={1200}
          delay={200}
          useNativeDriver
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingHorizontal: moderateScale(tokens.spacing.sm),
            paddingBottom: moderateScale(tokens.spacing.sm),
          }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: moderateScale(tokens.spacing.xxs),
            }}>
            <UserAvatar
              avatarUrl={heroUserAvatar}
              userName={heroUserName}
              size={40}
              style={{
                marginRight: 10,
                borderWidth: 1.5,
                borderColor: theme.colors.button1,
              }}
              onPress={
                heroUserId
                  ? () => {
                      navigate('UserProfileScreen', {
                        userId: heroUserId,
                        userName: heroUserName,
                        userAvatar: heroUserAvatar,
                      });
                    }
                  : undefined
              }
            />
            <Text
              style={{
                fontSize: fontScale(tokens.fontSize['3xl']),
                fontWeight: tokens.fontWeight.bold,
                color: '#ffffff',
                textShadowColor: 'rgba(0, 0, 0, 0.5)',
                textShadowOffset: {width: 0, height: 2},
                textShadowRadius: 4,
              }}>
              @{heroUserName}
            </Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 6,
            }}>
            {heroTags.slice(0, 3).map(tag => (
              <Pressable key={tag} onPress={() => handleTagTap(tag)} hitSlop={8}>
                <Text
                  style={{
                    fontSize: fontScale(tokens.fontSize.sm),
                    color: 'rgba(255,255,255,0.85)',
                    backgroundColor: 'rgba(59, 59, 59, 0.7)',
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 8,
                    overflow: 'hidden',
                  }}>
                  #{tag}
                </Text>
              </Pressable>
            ))}
            <Text
              style={{
                fontSize: fontScale(tokens.fontSize.sm),
                fontWeight: tokens.fontWeight.medium,
                color: 'rgba(255, 255, 255, 0.9)',
                marginLeft: 4,
                textShadowColor: 'rgba(0, 0, 0, 0.4)',
                textShadowOffset: {width: 0, height: 1},
                textShadowRadius: 3,
              }}>
              • {heroLikes} likes • {heroViews} views
            </Text>
          </View>
        </Animatable.View>
      </Pressable>
    );
  }, [
    displayedPosts,
    currentImageIndex,
    fadeAnim,
    theme.colors.button1,
    handleTagTap,
    navigate,
    openPostDetailModal,
    getPostLikeCount,
  ]);

  // Render API post card (works with CommunityPost type)
  const renderPostCard = useCallback(
    (post: CommunityPost, index: number) => {
      const liked = isPostLiked(post);
      // Use || to treat empty strings as falsy
      const imageUri =
        post.image_url ||
        post.top_image ||
        (post as any).imageUrl ||
        (post as any).image;

      return (
        <View
          style={{
            width: CARD_WIDTH,
            marginLeft: index % 2 === 0 ? 0 : 6,
          }}>
          <AppleTouchFeedback
            hapticStyle="none"
            onPress={() => openPostDetailModal(post)}
            style={[styles.card, {backgroundColor: theme.colors.imageBackground}]}>
            <FastImage
              source={{
                uri: imageUri || '',
                priority: FastImage.priority.normal,
                cache: FastImage.cacheControl.immutable,
              }}
              style={styles.cardImage}
              resizeMode={FastImage.resizeMode.cover}
            />
            
            <View style={styles.cardOverlayContainer}>
              <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.7)']}
                style={styles.cardGradient}
              />
              <View style={styles.cardContent}>
                <View style={styles.cardUserRow}>
                  <UserAvatar
                    avatarUrl={post.user_avatar}
                    userName={post.user_name}
                    size={35}
                    style={styles.cardAvatar}
                    onPress={() => {
                      navigate('UserProfileScreen', {
                        userId: post.user_id,
                        userName: post.user_name,
                        userAvatar: post.user_avatar,
                      });
                    }}
                  />
                  <Text style={styles.cardUserName} numberOfLines={1}>
                    @{post.user_name}
                  </Text>
                </View>
                <View style={styles.cardActions}>
                  <View style={styles.cardTags}>
                    {post.tags.slice(0, 3).map(tag => (
                      <Pressable
                        key={tag}
                        onPress={() => handleTagTap(tag)}
                        hitSlop={8}>
                        <Text style={styles.cardTag}>#{tag}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.actionButtonsRow}>
                    <AppleTouchFeedback
                      hapticStyle="none"
                      onPress={() => toggleLike(post)}
                      style={styles.likeButton}>
                      <MaterialIcons
                        name={liked ? 'favorite' : 'favorite-border'}
                        size={HEART_ICON_SIZE}
                        color={liked ? '#FF4D6D' : '#fff'}
                      />
                      <Text style={styles.likeCount}>
                        {getPostLikeCount(post)}
                      </Text>
                    </AppleTouchFeedback>
                    <View style={styles.likeButton}>
                      <MaterialIcons name="visibility" size={16} color="#fff" />
                      <Text style={styles.likeCount}>
                        {post.views_count ?? 0}
                      </Text>
                    </View>
                    <AppleTouchFeedback
                      hapticStyle="selection"
                      onPress={() => openActionsModal(post)}
                      style={styles.moreButton}>
                      <MaterialIcons name="more-horiz" size={22} color="#fff" />
                    </AppleTouchFeedback>
                  </View>
                </View>
              </View>
            </View>
          </AppleTouchFeedback>

          {/* Name below card */}
          {post.name && (
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: fontScale(13),
                fontWeight: '600',
                marginTop: -10,
                marginBottom: 16,
                paddingHorizontal: 2,
              }}
              numberOfLines={1}>
              {post.name}
            </Text>
          )}
        </View>
      );
    },
    [
      isPostLiked,
      getPostLikeCount,
      theme.colors.background,
      theme.colors.foreground,
      styles,
      handleTagTap,
      navigate,
      openPostDetailModal,
      toggleLike,
      openActionsModal,
    ],
  );

  // FlashList renderItem
  const renderItem = useCallback(
    ({item}: {item: FlashListItem}) => {
      if (item.type === 'hero') {
        return renderHeroSection();
      }

      if (item.type === 'post') {
        return renderPostCard(item.post, item.index);
      }

      return null;
    },
    [renderHeroSection, renderPostCard],
  );

  // FlashList key extractor
  const keyExtractor = useCallback((item: FlashListItem) => item.id, []);

  // FlashList getItemType for better performance
  const getItemType = useCallback((item: FlashListItem) => item.type, []);

  // FlashList overrideItemLayout for accurate sizing
  const overrideItemLayout = useCallback(
    (
      layout: {span?: number; size?: number},
      item: FlashListItem,
    ): void => {
      if (item.type === 'hero') {
        layout.size = 314; // 300 height + 14 margin
        layout.span = NUM_COLUMNS;
      } else {
        layout.size = CARD_HEIGHT + 50; // card + name + margins
        layout.span = 1;
      }
    },
    [],
  );

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity: screenFade,
          transform: [{translateY: screenTranslate}],
        },
      ]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={{alignItems: 'flex-start', flex: 1}}>
            <Text style={[globalStyles.header, {color: theme.colors.primary, marginBottom: 0, paddingLeft: 0}]}>Style Feed</Text>
            <Text style={styles.headerSubtitle}>Looks shared by the community</Text>
          </View>
          <Pressable
            onPress={() => {
              h('selection');
              navigate('MessagesScreen');
            }}
            style={styles.searchIcon}>
            <MaterialIcons
              name="send"
              size={22}
              color={theme.colors.foreground}
            />
            {unreadCount > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            )}
          </Pressable>
          <Pressable onPress={toggleSearch} style={styles.searchIcon}>
            <MaterialIcons
              name={showSearch ? 'close' : 'search'}
              size={24}
              color={theme.colors.foreground}
            />
          </Pressable>
        </View>
      </View>

      {/* Animated Search Bar - Slides open from right */}
      {showSearch && (
        <Animated.View
          style={[
            styles.searchContainer,
            {
              opacity: searchAnim.interpolate({
                inputRange: [0, 0.2, 1],
                outputRange: [0, 1, 1],
              }),
              transform: [
                {
                  translateX: searchAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [150, 0],
                  }),
                },
              ],
            },
          ]}>
          <MaterialIcons name="search" size={20} color={theme.colors.muted} />
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Search users or tags..."
            placeholderTextColor={theme.colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={12}>
              <MaterialIcons
                name="close"
                size={18}
                color={theme.colors.muted}
              />
            </Pressable>
          )}
        </Animated.View>
      )}

      {/* Filter Pills */}
      <View style={styles.filtersContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filtersScroll}>
          {filters.map(filter => (
            <AppleTouchFeedback
              key={filter}
              hapticStyle="selection"
              onPress={() => {
                setActiveFilter(filter);
              }}
              style={[
                styles.filterPill,
                activeFilter === filter && styles.filterPillActive,
              ]}>
              <Text
                style={[
                  styles.filterText,
                  activeFilter === filter && styles.filterTextActive,
                ]}>
                {filter}
              </Text>
            </AppleTouchFeedback>
          ))}
        </ScrollView>
      </View>

      {/* People Search Results - Show when searching */}
      {searchQuery.trim().length > 0 && userSearchResults?.users && userSearchResults.users.length > 0 && (
        <View style={{paddingHorizontal: 12, marginBottom: 12}}>
          <Text style={{
            fontSize: 15,
            fontWeight: '600',
            color: theme.colors.foreground,
            marginBottom: 10,
          }}>
            People
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{gap: 12}}>
            {userSearchResults.users.slice(0, 10).map((user) => (
              <AppleTouchFeedback
                key={user.id}
                hapticStyle="selection"
                onPress={() => {
                  h('selection');
                  navigate('UserProfileScreen', {userId: user.id});
                }}
                style={{
                  alignItems: 'center',
                  width: 72,
                }}>
                <UserAvatar
                  avatarUrl={user.profile_picture_url}
                  userName={user.display_name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User'}
                  size={56}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 12,
                    color: theme.colors.foreground2,
                    marginTop: 6,
                    textAlign: 'center',
                    width: 72,
                  }}>
                  {user.display_name?.trim() || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User'}
                </Text>
              </AppleTouchFeedback>
            ))}
          </ScrollView>
          {searchResults.length > 0 && (
            <Text style={{
              fontSize: 15,
              fontWeight: '600',
              color: theme.colors.foreground,
              marginTop: 16,
              marginBottom: 4,
            }}>
              Posts
            </Text>
          )}
        </View>
      )}

      {/* Content - FlashList */}
      {displayedPosts.length > 0 || !isLoading ? (
        <FlashList
          ref={flashListRef}
          data={flashListData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          overrideItemLayout={overrideItemLayout}
          extraData={{userLikedPosts, userFollows, userSavedPosts}}
          numColumns={NUM_COLUMNS}
          showsVerticalScrollIndicator={false}
          drawDistance={CARD_HEIGHT * 2}
          removeClippedSubviews={true}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={onRefresh}
              tintColor={theme.colors.foreground}
            />
          }
          contentContainerStyle={styles.gridContainer}
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="large" color={theme.colors.button1} />
                <Text style={[styles.emptySubtitle, {marginTop: 16}]}>
                  Loading posts...
                </Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <MaterialIcons
                    name="people-outline"
                    size={40}
                    color={theme.colors.muted}
                  />
                </View>
                <Text style={styles.emptyTitle}>No looks yet</Text>
                <Text style={styles.emptySubtitle}>
                  Be the first to share your style with the community!
                </Text>

                <AppleTouchFeedback
                  hapticStyle="impactMedium"
                  onPress={() => {
                    h('impactMedium');
                    navigate('SavedOutfitsScreen');
                  }}
                  style={styles.ctaButton}>
                  <Text style={styles.ctaText}>Share Your First Look</Text>
                </AppleTouchFeedback>
              </View>
            )
          }
        />
      ) : (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color={theme.colors.button1} />
          <Text style={[styles.emptySubtitle, {marginTop: 16}]}>
            Loading posts...
          </Text>
        </View>
      )}

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
          backgroundColor: 'rgba(0, 0, 0, 0.43)',
          borderColor: theme.colors.muted,
          borderWidth: tokens.borderWidth.md,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 8,
          shadowOffset: {width: 0, height: 4},
        }}>
        <MaterialIcons name="keyboard-arrow-up" size={32} color={'white'} />
      </AppleTouchFeedback>

      {/* Comments Modal - Instagram Style */}
      <Modal
        visible={commentsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCommentsModalVisible(false)}>
        <KeyboardAvoidingView
          style={{flex: 1}}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}>
          <View style={styles.modalOverlay}>
            <Pressable
              style={{flex: 1}}
              onPress={() => setCommentsModalVisible(false)}
            />
            <View style={styles.commentsModal}>
              {/* Drag Handle */}
              <View style={styles.modalHandle} />

              {/* Header - Instagram style centered */}
              <View style={styles.commentsHeader}>
                <Text style={styles.commentsTitle}>Comments</Text>
              </View>

              {/* Comments List */}
              <FlatList
                data={commentsData}
                keyExtractor={item => item.id}
                style={{flex: 1}}
                bounces
                scrollEnabled
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.commentsList}
                ListEmptyComponent={
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyTitle}>No comments yet</Text>
                    <Text style={styles.emptySubtitle}>
                      Start the conversation.
                    </Text>
                  </View>
                }
                renderItem={({item}) => (
                  <View style={styles.commentItem}>
                    {/* Avatar */}
                    <UserAvatar
                      avatarUrl={item.user_avatar}
                      userName={item.user_name}
                      size={35}
                      style={styles.commentAvatar}
                      onPress={() => {
                        setCommentsModalVisible(false);
                        navigate('UserProfileScreen', {
                          userId: item.user_id,
                          userName: item.user_name,
                          userAvatar: item.user_avatar,
                        });
                      }}
                    />

                    {/* Comment Content */}
                    <View style={styles.commentContent}>
                      {/* Username + Time on same line */}
                      <View style={styles.commentHeader}>
                        <Text style={styles.commentUser}>{item.user_name}</Text>
                        <Text style={styles.commentTime}>
                          {getRelativeTime(item.created_at)}
                        </Text>
                      </View>

                      {/* Comment text with @mention/ */}
                      <Text style={styles.commentText}>
                        {item.reply_to_user && (
                          <Text style={styles.commentMention}>
                            @{item.reply_to_user}{' '}
                          </Text>
                        )}
                        {item.content}
                      </Text>

                      {/* Reply button */}
                      <Pressable
                        onPress={() => startReply(item.id, item.user_name)}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                        <Text style={styles.commentReplyButton}>Reply</Text>
                      </Pressable>
                    </View>

                    {/* Like Button + Count + Delete on Right */}
                    <View style={styles.commentLikeContainer}>
                      {/* Delete button - only for own comments */}
                      {item.user_id === userId && (
                        <Pressable
                          onPress={() =>
                            activePostId &&
                            handleDeleteComment(activePostId, item.id)
                          }
                          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                          <MaterialIcons
                            name="delete-outline"
                            size={18}
                            color={theme.colors.muted}
                          />
                        </Pressable>
                      )}
                      <Pressable
                        onPress={() =>
                          activePostId &&
                          handleToggleLikeComment(activePostId, item)
                        }
                        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <MaterialIcons
                          name={
                            isCommentLiked(item)
                              ? 'favorite'
                              : 'favorite-border'
                          }
                          size={18}
                          color={
                            isCommentLiked(item)
                              ? '#FF3040'
                              : theme.colors.foreground
                          }
                        />
                      </Pressable>
                      {getCommentLikeCount(item) > 0 && (
                        <Text style={styles.commentLikesCount}>
                          {getCommentLikeCount(item) > 999
                            ? `${(getCommentLikeCount(item) / 1000).toFixed(0)}K`
                            : getCommentLikeCount(item)}
                        </Text>
                      )}
                    </View>
                  </View>
                )}
              />

              {/* Reply indicator */}
              {replyingTo && (
                <View style={styles.replyingToContainer}>
                  <Text style={styles.replyingToText}>
                    Replying to{' '}
                    <Text style={{fontWeight: '600'}}>@{replyingTo.user}</Text>
                  </Text>
                  <Pressable
                    onPress={cancelReply}
                    hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                    <MaterialIcons
                      name="close"
                      size={18}
                      color={theme.colors.muted}
                    />
                  </Pressable>
                </View>
              )}

              {/* Input Area - Instagram style */}
              <View style={styles.commentInputContainer}>
                <TextInput
                  style={styles.commentInput}
                  placeholder={
                    replyingTo
                      ? `Reply to @${replyingTo.user}...`
                      : 'Add a comment...'
                  }
                  placeholderTextColor={theme.colors.muted}
                  value={newComment}
                  onChangeText={setNewComment}
                  multiline
                  maxLength={2200}
                />
                <Pressable
                  onPress={handleAddComment}
                  disabled={!newComment.trim()}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                  <Text
                    style={[
                      styles.postButton,
                      !newComment.trim() && styles.postButtonDisabled,
                    ]}>
                    Post
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Actions Modal (Pinterest-style) */}
      <Modal
        visible={actionsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setActionsModalVisible(false)}>
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setActionsModalVisible(false)}>
          <View style={styles.actionsModal}>
            <Pressable onPress={e => e.stopPropagation()}>
              <View style={styles.modalHandle} />

              {activeActionsPost && (
                <>
                  {/* User info row */}
                  <View style={styles.actionsUserRow}>
                    <UserAvatar
                      avatarUrl={activeActionsPost.user_avatar}
                      userName={activeActionsPost.user_name}
                      size={44}
                      style={styles.actionsAvatar}
                      onPress={() => {
                        setActionsModalVisible(false);
                        navigate('UserProfileScreen', {
                          userId: activeActionsPost.user_id,
                          userName: activeActionsPost.user_name,
                          userAvatar: activeActionsPost.user_avatar,
                        });
                      }}
                    />
                    <View style={styles.actionsUserInfo}>
                      <Text style={styles.actionsUserName}>
                        {activeActionsPost.user_name}
                      </Text>
                      <Text style={styles.actionsUserHandle}>
                        @
                        {activeActionsPost.user_name
                          .toLowerCase()
                          .replace(/\s+/g, '')}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        toggleFollow(activeActionsPost);
                      }}
                      style={[
                        styles.followButton,
                        isFollowingAuthor(activeActionsPost) &&
                          styles.followButtonFollowing,
                        {
                          marginLeft: 0,
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                        },
                      ]}>
                      <Text style={styles.followButtonText}>
                        {isFollowingAuthor(activeActionsPost)
                          ? 'Following'
                          : 'Follow'}
                      </Text>
                    </Pressable>
                  </View>

                  {/* Actions list */}
                  <View style={styles.actionsList}>
                    {/* Send Message */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        setActionsModalVisible(false);
                        navigate('ChatScreen', {
                          recipientId: activeActionsPost.user_id,
                          recipientName: activeActionsPost.user_name,
                          recipientAvatar: activeActionsPost.user_avatar,
                        });
                      }}>
                      <View style={styles.actionIcon}>
                        <MaterialIcons
                          name="send"
                          size={20}
                          color={theme.colors.foreground}
                        />
                      </View>
                      <Text style={styles.actionText}>Direct Message</Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color={theme.colors.muted}
                        style={styles.actionChevron}
                      />
                    </Pressable>

                    {/* View Comments */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        const postId = activeActionsPost.id;
                        setActionsModalVisible(false);
                        setTimeout(() => openComments(postId), 300);
                      }}>
                      <View style={styles.actionIcon}>
                        <MaterialIcons
                          name="chat-bubble-outline"
                          size={20}
                          color={theme.colors.foreground}
                        />
                      </View>
                      <Text style={styles.actionText}>
                        Comments{' '}
                        {activeActionsPost.comments_count > 0 &&
                          `(${activeActionsPost.comments_count})`}
                      </Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color={theme.colors.muted}
                        style={styles.actionChevron}
                      />
                    </Pressable>

                    {/* Save/Bookmark */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        toggleSavePost(activeActionsPost);
                      }}>
                      <View style={styles.actionIcon}>
                        <MaterialIcons
                          name={
                            isPostSaved(activeActionsPost)
                              ? 'bookmark'
                              : 'bookmark-border'
                          }
                          size={20}
                          color={
                            isPostSaved(activeActionsPost)
                              ? '#FFD700'
                              : theme.colors.foreground
                          }
                        />
                      </View>
                      <Text style={styles.actionText}>
                        {isPostSaved(activeActionsPost) ? 'Unsave' : 'Save'}
                      </Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color={theme.colors.muted}
                        style={styles.actionChevron}
                      />
                    </Pressable>

                    {/* Edit Own Post - only show if it's user's post */}
                    {activeActionsPost.user_id === userId && (
                      <Pressable
                        style={styles.actionItem}
                        onPress={() => handleOpenEditModal(activeActionsPost)}>
                        <View
                          style={[
                            styles.actionIcon,
                            {backgroundColor: 'rgba(100,150,255,0.1)'},
                          ]}>
                          <MaterialIcons
                            name="edit"
                            size={20}
                            color="#6496FF"
                          />
                        </View>
                        <Text style={[styles.actionText, {color: '#6496FF'}]}>
                          Edit Post
                        </Text>
                        <MaterialIcons
                          name="chevron-right"
                          size={20}
                          color="#6496FF"
                          style={[styles.actionChevron, {opacity: 0.6}]}
                        />
                      </Pressable>
                    )}

                    {/* Delete Own Post - only show if it's user's post */}
                    {activeActionsPost.user_id === userId && (
                      <Pressable
                        style={styles.actionItem}
                        onPress={() => handleDeletePost(activeActionsPost)}>
                        <View
                          style={[
                            styles.actionIcon,
                            {backgroundColor: 'rgba(255,77,109,0.1)'},
                          ]}>
                          <MaterialIcons
                            name="delete"
                            size={20}
                            color="#FF4D6D"
                          />
                        </View>
                        <Text style={[styles.actionText, {color: '#FF4D6D'}]}>
                          Delete Post
                        </Text>
                        <MaterialIcons
                          name="chevron-right"
                          size={20}
                          color="#FF4D6D"
                          style={[styles.actionChevron, {opacity: 0.6}]}
                        />
                      </Pressable>
                    )}

                    {/* Mute User */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        handleMuteUser(activeActionsPost);
                      }}>
                      <View style={styles.actionIcon}>
                        <MaterialIcons
                          name={
                            mutedUsers.has(activeActionsPost.user_id)
                              ? 'volume-up'
                              : 'volume-off'
                          }
                          size={20}
                          color={theme.colors.foreground}
                        />
                      </View>
                      <Text style={styles.actionText}>
                        {mutedUsers.has(activeActionsPost.user_id)
                          ? 'Unmute'
                          : 'Mute'}{' '}
                        @{activeActionsPost.user_name}
                      </Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color={theme.colors.muted}
                        style={styles.actionChevron}
                      />
                    </Pressable>

                    {/* Block/Unblock User */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        handleBlockUser(activeActionsPost);
                      }}>
                      <View
                        style={[
                          styles.actionIcon,
                          {
                            backgroundColor: blockedUsers.has(
                              activeActionsPost.user_id,
                            )
                              ? 'rgba(100,200,100,0.1)'
                              : 'rgba(255,77,109,0.1)',
                          },
                        ]}>
                        <MaterialIcons
                          name={
                            blockedUsers.has(activeActionsPost.user_id)
                              ? 'check-circle'
                              : 'block'
                          }
                          size={20}
                          color={
                            blockedUsers.has(activeActionsPost.user_id)
                              ? '#4CAF50'
                              : '#FF4D6D'
                          }
                        />
                      </View>
                      <Text
                        style={[
                          styles.actionText,
                          {
                            color: blockedUsers.has(activeActionsPost.user_id)
                              ? '#4CAF50'
                              : '#FF4D6D',
                          },
                        ]}>
                        {blockedUsers.has(activeActionsPost.user_id)
                          ? 'Unblock'
                          : 'Block'}{' '}
                        @{activeActionsPost.user_name}
                      </Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color={
                          blockedUsers.has(activeActionsPost.user_id)
                            ? '#4CAF50'
                            : '#FF4D6D'
                        }
                        style={[styles.actionChevron, {opacity: 0.6}]}
                      />
                    </Pressable>

                    {/* Report */}
                    <Pressable
                      style={styles.actionItem}
                      onPress={() => {
                        handleReportPost(activeActionsPost);
                      }}>
                      <View
                        style={[
                          styles.actionIcon,
                          {backgroundColor: 'rgba(255,77,109,0.1)'},
                        ]}>
                        <MaterialIcons name="flag" size={20} color="#FF4D6D" />
                      </View>
                      <Text style={[styles.actionText, {color: '#FF4D6D'}]}>
                        Report
                      </Text>
                      <MaterialIcons
                        name="chevron-right"
                        size={20}
                        color="#FF4D6D"
                        style={[styles.actionChevron, {opacity: 0.6}]}
                      />
                    </Pressable>
                  </View>
                </>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Edit Post Modal */}
      <Modal
        visible={editModalVisible}
        transparent={false}
        animationType="slide"
        onRequestClose={() => setEditModalVisible(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{flex: 1, backgroundColor: theme.colors.background}}>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: moderateScale(tokens.spacing.lg),
              paddingTop: insets.top + moderateScale(tokens.spacing.sm),
              paddingBottom: moderateScale(tokens.spacing.sm),
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.surface,
            }}>
            <Pressable onPress={() => setEditModalVisible(false)}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: fontScale(tokens.fontSize.base),
                }}>
                Cancel
              </Text>
            </Pressable>
            <Text
              style={{
                fontSize: fontScale(tokens.fontSize.lg),
                fontWeight: tokens.fontWeight.bold,
                color: theme.colors.foreground,
              }}>
              Edit Post
            </Text>
            <Pressable onPress={handleSaveEdit}>
              <Text
                style={{
                  color: theme.colors.primary,
                  fontSize: fontScale(tokens.fontSize.base),
                  fontWeight: tokens.fontWeight.semiBold,
                }}>
                Save
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{
              padding: moderateScale(tokens.spacing.sm),
              paddingBottom: insets.bottom + moderateScale(tokens.spacing.xl),
            }}
            keyboardShouldPersistTaps="handled">
            <Text style={[styles.editLabel, {color: theme.colors.foreground}]}>
              Name
            </Text>
            <TextInput
              style={[
                styles.editInput,
                {
                  backgroundColor: theme.colors.surface,
                  color: theme.colors.foreground,
                  borderColor: theme.colors.surface,
                  minHeight: 44,
                },
              ]}
              value={editName}
              onChangeText={setEditName}
              placeholder="Give your post a name"
              placeholderTextColor={theme.colors.muted}
              maxLength={100}
            />

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <Text
                style={[styles.editLabel, {color: theme.colors.foreground}]}>
                Story
              </Text>
              <Pressable
                onPress={isVoiceRecording ? stopVoiceInput : startVoiceInput}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: moderateScale(4),
                  paddingHorizontal: moderateScale(8),
                  borderRadius: moderateScale(16),
                  backgroundColor: isVoiceRecording
                    ? '#FF4D6D'
                    : theme.colors.surface,
                }}>
                <MaterialIcons
                  name={isVoiceRecording ? 'mic-off' : 'mic'}
                  size={fontScale(16)}
                  color={isVoiceRecording ? '#fff' : theme.colors.foreground}
                />
                <Text
                  style={{
                    marginLeft: moderateScale(4),
                    fontSize: fontScale(tokens.fontSize.sm),
                    color: isVoiceRecording ? '#fff' : theme.colors.foreground,
                  }}>
                  {isVoiceRecording ? 'Stop' : 'Voice'}
                </Text>
              </Pressable>
            </View>
            <TextInput
              style={[
                styles.editInput,
                {
                  backgroundColor: theme.colors.surface,
                  color: theme.colors.foreground,
                  borderColor: theme.colors.surface,
                  minHeight: 550,
                },
              ]}
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Tell the story behind this look... What inspired you? Where would you wear it? Share the details!"
              placeholderTextColor={theme.colors.muted}
              multiline
              maxLength={2000}
            />

            <Text style={[styles.editLabel, {color: theme.colors.foreground}]}>
              Tags (comma separated)
            </Text>
            <TextInput
              style={[
                styles.editInput,
                {
                  backgroundColor: theme.colors.surface,
                  color: theme.colors.foreground,
                  borderColor: theme.colors.surface,
                  minHeight: 44,
                },
              ]}
              value={editTags}
              onChangeText={setEditTags}
              placeholder="casual, summer, streetwear"
              placeholderTextColor={theme.colors.muted}
              maxLength={200}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Post Detail Modal (Social Media Exploded View) */}
      <Modal
        visible={postDetailModalVisible}
        transparent
        statusBarTranslucent
        animationType="none"
        onRequestClose={closePostDetailModal}>
        <Animated.View
          style={[
            styles.postDetailOverlay,
            {
              opacity: postDetailOpacityAnim,
            },
          ]}>
          <Animated.View
            style={[
              styles.postDetailContainer,
              {
                transform: [
                  {
                    translateY: postDetailSlideAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [100, 0],
                    }),
                  },
                  {
                    scale: postDetailSlideAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.95, 1],
                    }),
                  },
                ],
              },
            ]}>
            {detailPost && (
              <ScrollView
                style={{flex: 1}}
                showsVerticalScrollIndicator={false}
                bounces={true}>
                {/* Header */}
                <View style={styles.postDetailHeader}>
                  <View style={styles.postDetailUserInfo}>
                    <UserAvatar
                      avatarUrl={detailPost.user_avatar}
                      userName={detailPost.user_name}
                      size={36}
                      style={styles.postDetailAvatar}
                      onPress={() => {
                        closePostDetailModal();
                        setTimeout(() => {
                          navigate('UserProfileScreen', {
                            userId: detailPost.user_id,
                            userName: detailPost.user_name,
                            userAvatar: detailPost.user_avatar,
                          });
                        }, 300);
                      }}
                    />
                    <View>
                      <Text style={styles.postDetailUserName}>
                        {detailPost.user_name}
                      </Text>
                      <Text style={styles.postDetailHandle}>
                        @
                        {detailPost.user_name.toLowerCase().replace(/\s+/g, '')}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => toggleFollow(detailPost)}
                    style={[
                      styles.postDetailFollowButton,
                      isFollowingAuthor(detailPost) &&
                        styles.postDetailFollowButtonFollowing,
                    ]}>
                    <Text style={styles.postDetailFollowText}>
                      {isFollowingAuthor(detailPost) ? 'Following' : 'Follow'}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={closePostDetailModal}
                    style={styles.postDetailCloseButton}>
                    <MaterialIcons name="close" size={24} color="black" />
                  </Pressable>
                </View>

                {/* Image */}
                <View style={styles.postDetailImageContainer}>
                  <FastImage
                    source={{
                      uri: detailPost.image_url || detailPost.top_image || '',
                      priority: FastImage.priority.high,
                      cache: FastImage.cacheControl.immutable,
                    }}
                    style={styles.postDetailImage}
                    resizeMode={FastImage.resizeMode.contain}
                  />
                </View>

                {/* Footer */}
                <View style={styles.postDetailFooter}>
                  {/* Action buttons */}
                  <View style={styles.postDetailActionsRow}>
                    <View style={{flexDirection: 'row', gap: 20}}>
                      <Pressable
                        onPress={() => toggleLike(detailPost)}
                        style={styles.postDetailActionButton}>
                        <MaterialIcons
                          name={
                            isPostLiked(detailPost)
                              ? 'favorite'
                              : 'favorite-border'
                          }
                          size={28}
                          color={
                            isPostLiked(detailPost)
                              ? '#FF4D6D'
                              : theme.colors.foreground
                          }
                        />
                        <Text style={styles.postDetailActionText}>
                          {getPostLikeCount(detailPost)}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          const postId = detailPost.id;
                          closePostDetailModal();
                          setTimeout(() => openComments(postId), 350);
                        }}
                        style={styles.postDetailActionButton}>
                        <MaterialIcons
                          name="chat-bubble-outline"
                          size={26}
                          color={theme.colors.foreground}
                        />
                        <Text style={styles.postDetailActionText}>
                          {detailPost.comments_count || 0}
                        </Text>
                      </Pressable>
                      {/* Stats */}
                      <View style={styles.postDetailStats}>
                        <Text style={styles.postDetailStat}>
                          {detailPost.views_count ?? 0} views
                        </Text>
                      </View>
                    </View>
                    <View style={styles.postDetailRightActions}>
                      <Pressable
                        onPress={() => {
                          // Toggle save without affecting modal visibility
                          h('impactLight');
                          const currentlySaved = isPostSaved(detailPost);
                          setUserSavedPosts(prev => {
                            const next = new Map(prev);
                            next.set(detailPost.id, !currentlySaved);
                            return next;
                          });
                          if (userId) {
                            saveMutation.mutate({
                              postId: detailPost.id,
                              userId,
                              isSaved: currentlySaved,
                            });
                          }
                        }}
                        style={styles.postDetailActionButton}>
                        <MaterialIcons
                          name={
                            isPostSaved(detailPost)
                              ? 'bookmark'
                              : 'bookmark-border'
                          }
                          size={28}
                          color={
                            isPostSaved(detailPost)
                              ? '#FFD700'
                              : theme.colors.foreground
                          }
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          closePostDetailModal();
                          setTimeout(() => openActionsModal(detailPost), 350);
                        }}
                        style={styles.postDetailActionButton}>
                        <MaterialIcons
                          name="more-horiz"
                          size={28}
                          color={theme.colors.foreground}
                        />
                      </Pressable>
                    </View>
                  </View>

                  {/* Name */}
                  {detailPost.name && (
                    <Text style={styles.postDetailTitle}>
                      {detailPost.name}
                    </Text>
                  )}

                  {/* Tags */}
                  {detailPost.tags && detailPost.tags.length > 0 && (
                    <View style={styles.postDetailTagsRow}>
                      {detailPost.tags.map(tag => (
                        <Pressable
                          key={tag}
                          onPress={() => {
                            handleTagTap(tag);
                            closePostDetailModal();
                          }}>
                          <Text style={styles.postDetailTag}>#{tag}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}

                  {/* Story/Description */}
                  {detailPost.description && (
                    <Text style={styles.postDetailStory}>
                      {detailPost.description}
                    </Text>
                  )}
                </View>
              </ScrollView>
            )}
          </Animated.View>
        </Animated.View>
      </Modal>
    </Animated.View>
  );
}
