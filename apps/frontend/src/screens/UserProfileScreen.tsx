import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  FlatList,
} from 'react-native';
import {useAppTheme} from '../context/ThemeContext';
import {useQuery} from '@tanstack/react-query';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {API_BASE_URL} from '../config/api';
import {apiClient} from '../lib/apiClient';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import * as Animatable from 'react-native-animatable';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  useFollowers,
  useFollowing,
  useFollowUser,
  useTrackProfileVisit,
} from '../hooks/useCommunityApi';
import {useUUID} from '../context/UUIDContext';
import type {FollowUser} from '../types/community';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import SharedLookDetailModal from '../components/SavedLookModal/SharedLookDetailModal';

type Props = {
  navigate: (screen: string, params?: any) => void;
  route?: {
    userId: string;
    userName?: string;
    userAvatar?: string;
  };
  goBack?: () => void;
};

type UserProfile = {
  first_name: string;
  last_name: string;
  email: string;
  profile_picture?: string;
  bio?: string;
  fashion_level?: string;
  profession?: string;
};

type SharedLook = {
  id: string;
  image_url?: string;
  top_image?: string;
  bottom_image?: string;
  shoes_image?: string;
  name?: string;
  description?: string;
};

const h = (type: 'selection' | 'impactLight' | 'impactMedium') =>
  ReactNativeHapticFeedback.trigger(type, {
    enableVibrateFallback: true,
    ignoreAndroidSystemSettings: false,
  });

// Helper to get initials from name
const getInitials = (name: string): string => {
  const parts = name.trim().split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Check if avatar is real
const isRealAvatarUrl = (url: string | null | undefined): boolean => {
  if (!url) return false;
  return !url.includes('pravatar.cc');
};

export default function UserProfileScreen({navigate, route, goBack}: Props) {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const insets = useSafeAreaInsets();
  const currentUserId = useUUID();

  const userId = route?.userId;
  const passedName = route?.userName;
  const passedAvatar = route?.userAvatar;

  const BOTTOM_NAV_HEIGHT = 90;

  const [sharedLooks, setSharedLooks] = useState<SharedLook[]>([]);
  const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
  const [isSharedLookModalVisible, setIsSharedLookModalVisible] = useState(false);
  const [selectedSharedLook, setSelectedSharedLook] = useState<any>(null);
  const [followListModal, setFollowListModal] = useState<
    'followers' | 'following' | null
  >(null);

  // Fetch user profile (includes bio from community endpoint)
  const {data: communityProfile} = useQuery<{
    user_name: string;
    user_avatar: string;
    bio?: string;
    followers_count: number;
    following_count: number;
    posts_count: number;
  }>({
    enabled: !!userId,
    queryKey: ['communityUserProfile', userId],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE_URL}/community/users/${userId}/profile`,
      );
      if (!res.ok) return null;
      return res.json();
    },
  });

  // Fetch user profile (basic info)
  const {data: userProfile, isLoading: loadingProfile} = useQuery<UserProfile>({
    enabled: !!userId,
    queryKey: ['publicUserProfile', userId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/users/${userId}`);
      if (!res.ok) throw new Error('Failed to fetch user profile');
      return res.json();
    },
  });

  // Fetch followers/following lists
  const {data: followers = [], isLoading: loadingFollowers} = useFollowers(
    userId || '',
    currentUserId || '',
  );
  const {data: following = [], isLoading: loadingFollowing} = useFollowing(
    userId || '',
    currentUserId || '',
  );
  const followMutation = useFollowUser();
  const trackVisit = useTrackProfileVisit();

  // Track profile visit (only for other users, on mount or userId change)
  useEffect(() => {
    if (userId && currentUserId && userId !== currentUserId) {
      trackVisit.mutate({visitedId: userId});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, currentUserId]);

  // Fetch style profile by userId (for style tags)
  const {data: styleProfile} = useQuery({
    queryKey: ['publicStyleProfile', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await apiClient.get(`/style-profile/by-user-id/${userId}`);
      return res.data;
    },
  });
  const styleTags = styleProfile?.style_preferences || [];

  // Fetch wardrobe count
  const {data: wardrobeCount = 0} = useQuery({
    queryKey: ['publicWardrobeCount', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/wardrobe/count/${userId}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count;
    },
  });

  // Fetch favorites count
  const {data: totalFavorites = 0} = useQuery({
    queryKey: ['publicTotalFavorites', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE_URL}/outfit-favorites/count/${userId}`,
      );
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count;
    },
  });

  // Fetch custom outfits count
  const {data: totalCustomOutfits = 0} = useQuery({
    queryKey: ['publicTotalCustomOutfits', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count;
    },
  });

  // Fetch favorite brands
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await apiClient.get(
          `/style-profile/by-user-id/${userId}/brands`,
        );
        setFavoriteBrands(
          Array.isArray(res.data.brands) ? res.data.brands : [],
        );
      } catch {
        setFavoriteBrands([]);
      }
    })();
  }, [userId]);

  // Fetch shared looks
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/community/posts/by-user/${userId}?limit=20`,
        );
        if (!res.ok) throw new Error('Failed to fetch shared looks');
        const data = await res.json();
        setSharedLooks(data);
      } catch {
        setSharedLooks([]);
      }
    })();
  }, [userId]);

  const totalItems = wardrobeCount;

  // Initials fallback logic
  let initials = '';
  if (userProfile?.first_name || userProfile?.last_name) {
    const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
    const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
    initials = `${f}${l}`;
  } else if (passedName) {
    const parts = passedName.trim().split(' ').filter(Boolean);
    if (parts.length === 1) {
      initials = parts[0][0].toUpperCase();
    } else if (parts.length >= 2) {
      initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
  } else if (userProfile?.email) {
    const local = userProfile.email.split('@')[0];
    const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
    const f = (parts[0]?.[0] || '').toUpperCase();
    const l = (parts[1]?.[0] || '').toUpperCase();
    initials = f + l || local.slice(0, 2).toUpperCase();
  }

  // Filter out fake pravatar URLs - only use real profile pictures
  const isRealAvatar = (url?: string) => url && !url.includes('pravatar.cc');
  const profileUri = isRealAvatar(userProfile?.profile_picture)
    ? userProfile?.profile_picture
    : isRealAvatar(communityProfile?.user_avatar)
      ? communityProfile?.user_avatar
      : isRealAvatar(passedAvatar)
        ? passedAvatar
        : '';
  const displayName =
    userProfile?.first_name && userProfile?.last_name
      ? `${userProfile.first_name} ${userProfile.last_name}`
      : passedName || 'User';
  const username =
    userProfile?.first_name && userProfile?.last_name
      ? `@${userProfile.first_name.toLowerCase()}${userProfile.last_name.toLowerCase()}`
      : passedName
        ? `@${passedName.toLowerCase().replace(/\s+/g, '')}`
        : '@user';

  const handleMessage = () => {
    navigate('ChatScreen', {
      recipientId: userId,
      recipientName: displayName,
      recipientAvatar: profileUri,
    });
  };

  const handleBack = () => {
    if (goBack) {
      goBack();
    } else {
      navigate('MessagesScreen');
    }
  };

  const styles = StyleSheet.create({
    screen: {
      flex: 1,
    },
    topHeader: {
      paddingTop: insets.top + 60,
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: theme.colors.background,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    backText: {
      color: theme.colors.button1,
      fontSize: 16,
      marginLeft: 4,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
    },
    avatarWrapper: {
      marginRight: 20,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    },
    avatarBorder: {
      width: 100,
      height: 100,
      borderRadius: 50,
      borderWidth: tokens.borderWidth.xl,
      borderColor: theme.colors.surfaceBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatar: {
      width: 92,
      height: 92,
      borderRadius: 45,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    initialsText: {
      color: theme.colors.foreground,
      fontWeight: tokens.fontWeight.bold,
      fontSize: 30,
      letterSpacing: 0.5,
    },
    statsContainer: {
      flex: 1,
    },
    statsRow: {
      flexDirection: 'row',
      marginBottom: 8,
    },
    statBox: {
      flex: 1,
      alignItems: 'center',
    },
    statNumber: {
      fontWeight: tokens.fontWeight.bold,
      fontSize: 17,
      color: theme.colors.foreground2,
    },
    statLabel: {
      fontSize: 14,
      color: theme.colors.foreground3,
      fontWeight: tokens.fontWeight.semiBold,
    },
    bioContainer: {
      marginTop: 8,
    },
    nameText: {
      color: theme.colors.foreground,
      fontWeight: tokens.fontWeight.bold,
      fontSize: 17,
    },
    usernameText: {
      color: theme.colors.button1,
      fontSize: 16,
      marginTop: 2,
    },
    bioText: {
      color: theme.colors.foreground2,
      fontSize: 16,
      marginTop: 4,
      lineHeight: 18,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 100,
    },
  });

  if (!userId) {
    return (
      <View style={[styles.screen, {backgroundColor: theme.colors.background}]}>
        <View style={styles.loadingContainer}>
          <Text style={{color: theme.colors.foreground}}>User not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{flex: 1, backgroundColor: theme.colors.background}}>
      {/* Fixed Header with Back Button */}
      <View style={styles.topHeader}>
        <AppleTouchFeedback
          style={styles.backButton}
          onPress={handleBack}
          hapticStyle="impactLight">
          <Icon name="arrow-back" size={26} color={theme.colors.button1} />
          <Text style={styles.backText}>Back</Text>
        </AppleTouchFeedback>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          globalStyles.container,
          {
            backgroundColor: theme.colors.background,
            paddingTop: 0,
            paddingBottom: insets.bottom + BOTTOM_NAV_HEIGHT,
          },
        ]}>
        <Text style={globalStyles.header}>Profile</Text>

        {loadingProfile ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.button1} />
          </View>
        ) : (
          <>
            {/* Header Row */}
            <Animatable.View
              animation="fadeInUp"
              delay={300}
              style={globalStyles.section}>
              <View style={styles.headerRow}>
                {/* Avatar */}
                <Animatable.View
                  animation="pulse"
                  iterationCount="infinite"
                  duration={5000}
                  style={styles.avatarWrapper}>
                  <View style={styles.avatarBorder}>
                    {profileUri ? (
                      <Image source={{uri: profileUri}} style={styles.avatar} />
                    ) : (
                      <View style={styles.avatar}>
                        <Text style={styles.initialsText}>{initials}</Text>
                      </View>
                    )}
                  </View>
                </Animatable.View>

                {/* Stats */}
                <View style={styles.statsContainer}>
                  <Animatable.View
                    animation="fadeIn"
                    delay={500}
                    style={styles.statsRow}>
                    <View style={styles.statBox}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={600}
                        style={styles.statNumber}>
                        {totalItems}
                      </Animatable.Text>
                      <Text style={styles.statLabel}>Wardrobe</Text>
                    </View>
                    <View style={styles.statBox}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={800}
                        style={styles.statNumber}>
                        {totalCustomOutfits}
                      </Animatable.Text>
                      <Text style={styles.statLabel}>Outfits</Text>
                    </View>
                    <View style={styles.statBox}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={1000}
                        style={styles.statNumber}>
                        {totalFavorites}
                      </Animatable.Text>
                      <Text style={styles.statLabel}>Favorites</Text>
                    </View>
                  </Animatable.View>
                  <Animatable.View
                    animation="fadeIn"
                    delay={700}
                    style={styles.statsRow}>
                    <View style={styles.statBox}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={1100}
                        style={styles.statNumber}>
                        {sharedLooks.length}
                      </Animatable.Text>
                      <Text style={styles.statLabel}>Shared</Text>
                    </View>
                    <Pressable
                      style={styles.statBox}
                      onPress={() => {
                        h('selection');
                        setFollowListModal('following');
                      }}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={1200}
                        style={styles.statNumber}>
                        {communityProfile?.following_count || 0}
                      </Animatable.Text>
                      <Text
                        style={
                          (styles.statLabel, {color: theme.colors.button1})
                        }>
                        Following
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.statBox}
                      onPress={() => {
                        h('selection');
                        setFollowListModal('followers');
                      }}>
                      <Animatable.Text
                        animation="bounceIn"
                        delay={1300}
                        style={styles.statNumber}>
                        {communityProfile?.followers_count || 0}
                      </Animatable.Text>
                      <Text
                        style={
                          (styles.statLabel, {color: theme.colors.button1})
                        }>
                        Followers
                      </Text>
                    </Pressable>
                  </Animatable.View>
                </View>
              </View>

              {/* Bio Section */}
              <Animatable.View
                animation="fadeInUp"
                delay={1200}
                style={styles.bioContainer}>
                <Text style={styles.nameText}>{displayName}</Text>
                <Text style={styles.usernameText}>{username}</Text>

                {userProfile?.fashion_level && (
                  <Text style={styles.bioText}>
                    Style Level: {userProfile.fashion_level}
                  </Text>
                )}
                {userProfile?.profession && (
                  <Text style={styles.bioText}>
                    Profession: {userProfile.profession}
                  </Text>
                )}
                {(communityProfile?.bio || userProfile?.bio) && (
                  <Text style={styles.bioText}>
                    Bio: "{communityProfile?.bio || userProfile?.bio}""
                  </Text>
                )}
              </Animatable.View>
            </Animatable.View>

            {/* Message Button */}
            <Animatable.View
              animation="fadeInUp"
              delay={1400}
              style={globalStyles.section}>
              <View style={{alignItems: 'center'}}>
                <AppleTouchFeedback
                  onPress={handleMessage}
                  hapticStyle="impactLight"
                  style={[
                    globalStyles.buttonPrimary,
                    {
                      minWidth: 200,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginTop: 4,
                    },
                  ]}>
                  <Icon
                    name="message"
                    size={20}
                    color={theme.colors.buttonText1}
                    style={{marginRight: 8}}
                  />
                  <Text
                    style={{
                      color: theme.colors.buttonText1,
                      fontSize: 16,
                      fontWeight: tokens.fontWeight.medium,
                      flexShrink: 1,
                      textAlign: 'center',
                    }}
                    numberOfLines={1}>
                    Message
                  </Text>
                </AppleTouchFeedback>
              </View>
            </Animatable.View>

            {/* Style Tags */}
            <Animatable.View
              animation="fadeInLeft"
              delay={1500}
              style={globalStyles.sectionScroll}>
              <Text style={globalStyles.sectionTitle}>Style Tags</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{paddingRight: 8}}>
                {styleTags.length === 0 ? (
                  <Text style={globalStyles.missingDataMessage1}>
                    No saved styles.
                  </Text>
                ) : (
                  styleTags.map((tag: string, index: number) => (
                    <Animatable.View
                      key={tag}
                      animation="bounceInRight"
                      delay={1600 + index * 80}
                      useNativeDriver
                      style={[
                        globalStyles.pill2,
                        {backgroundColor: theme.colors.surface},
                      ]}>
                      <Text style={globalStyles.pillText2}>#{tag}</Text>
                    </Animatable.View>
                  ))
                )}
              </ScrollView>
            </Animatable.View>

            {/* Saved Brand Tags */}
            <Animatable.View
              animation="fadeInRight"
              delay={1700}
              style={globalStyles.sectionScroll}>
              <Text style={globalStyles.sectionTitle}>Saved Brand Tags</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{paddingRight: 8}}>
                {favoriteBrands.length === 0 ? (
                  <Text style={globalStyles.missingDataMessage1}>
                    No saved brands.
                  </Text>
                ) : (
                  favoriteBrands.map((brand, index) => (
                    <Animatable.View
                      key={brand}
                      animation="bounceInLeft"
                      delay={1800 + index * 90}
                      useNativeDriver
                      style={[
                        globalStyles.pill2,
                        {backgroundColor: theme.colors.surface},
                      ]}>
                      <Text style={globalStyles.pillText2}>#{brand}</Text>
                    </Animatable.View>
                  ))
                )}
              </ScrollView>
            </Animatable.View>

            {/* Shared Looks */}
            <Animatable.View
              animation="fadeInUpBig"
              delay={1900}
              style={globalStyles.sectionScroll}>
              <Text style={[globalStyles.sectionTitle]}>Your Shared Styles</Text>
              {sharedLooks.length === 0 ? (
                <Text style={globalStyles.missingDataMessage1}>
                  No shared looks yet.
                </Text>
              ) : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{paddingRight: 8}}>
                  {sharedLooks.map((look, index) => (
                    <Animatable.View
                      key={look.id}
                      animation="zoomInUp"
                      delay={1700 + index * 120}
                      useNativeDriver
                      style={[globalStyles.outfitCard, {width: 131}]}>
                      <Pressable
                        onPress={() => {
                          setSelectedSharedLook(look);
                          setIsSharedLookModalVisible(true);
                        }}
                     >
                        {/* Card - single image or 2x2 grid */}
                        <View
                          style={{
                          borderRadius: tokens.borderRadius.switch1,
                          backgroundColor: theme.colors.imageBackground,
                          overflow: 'hidden',
                          marginRight: 0
                        }}>
                          {look.image_url ? (
                            <Image
                              source={{uri: look.image_url}}
                              style={[globalStyles.image8]}
                              resizeMode="cover"
                              />
                          ) : null}
                        </View>

                        {/* Look description */}
                        <Animatable.View
                          animation="fadeIn"
                          delay={1900 + index * 100}
                          style={{marginTop: 2}}>
                          <Text
                            style={[
                              globalStyles.cardSubLabel,
                              {textAlign: 'left'},
                            ]}
                            numberOfLines={1}>
                            {look.name || 'Shared Look'}
                          </Text>
                        </Animatable.View>
                      </Pressable>
                    </Animatable.View>
                  ))}
                </ScrollView>
              )}
            </Animatable.View>
          </>
        )}
      </ScrollView>

      {/* Followers/Following Modal */}
      <Modal
        visible={followListModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setFollowListModal(null)}>
        <View style={{flex: 1, backgroundColor: theme.colors.background}}>
          {/* Modal Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: insets.top + 16,
              paddingHorizontal: 16,
              paddingBottom: 16,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.surfaceBorder,
            }}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: tokens.fontWeight.bold,
                color: theme.colors.foreground,
              }}>
              {followListModal === 'followers' ? 'Followers' : 'Following'}
            </Text>
            <Pressable
              onPress={() => {
                h('selection');
                setFollowListModal(null);
              }}
              hitSlop={12}>
              <Icon name="close" size={24} color={theme.colors.foreground} />
            </Pressable>
          </View>

          {/* List */}
          {(
            followListModal === 'followers'
              ? loadingFollowers
              : loadingFollowing
          ) ? (
            <View
              style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
              <ActivityIndicator size="large" color={theme.colors.button1} />
            </View>
          ) : (
            <FlatList
              data={followListModal === 'followers' ? followers : following}
              keyExtractor={item => item.id}
              extraData={followListModal === 'followers' ? followers : following}
              contentContainerStyle={{paddingBottom: insets.bottom + 20}}
              ListEmptyComponent={
                <View style={{padding: 40, alignItems: 'center'}}>
                  <Text style={{color: theme.colors.foreground3, fontSize: 16}}>
                    {followListModal === 'followers'
                      ? 'No followers yet'
                      : 'Not following anyone yet'}
                  </Text>
                </View>
              }
              renderItem={({item}: {item: FollowUser}) => {
                const hasAvatar = isRealAvatarUrl(item.user_avatar);
                const userInitials = getInitials(item.user_name);
                const isMe = item.id === currentUserId;

                return (
                  <Pressable
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.colors.surfaceBorder,
                    }}
                    onPress={() => {
                      h('selection');
                      setFollowListModal(null);
                      if (!isMe) {
                        navigate('UserProfileScreen', {
                          userId: item.id,
                          userName: item.user_name,
                          userAvatar: item.user_avatar,
                        });
                      }
                    }}>
                    {/* Avatar */}
                    {hasAvatar ? (
                      <Image
                        source={{uri: item.user_avatar}}
                        style={{
                          width: 50,
                          height: 50,
                          borderRadius: 25,
                          marginRight: 12,
                        }}
                      />
                    ) : (
                      <View
                        style={{
                          width: 50,
                          height: 50,
                          borderRadius: 25,
                          backgroundColor: theme.colors.surface,
                          justifyContent: 'center',
                          alignItems: 'center',
                          marginRight: 12,
                        }}>
                        <Text
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 18,
                            fontWeight: '600',
                          }}>
                          {userInitials}
                        </Text>
                      </View>
                    )}

                    {/* Name & Bio */}
                    <View style={{flex: 1}}>
                      <Text
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 16,
                          fontWeight: '600',
                        }}
                        numberOfLines={1}>
                        {item.user_name}
                      </Text>
                      {item.bio && (
                        <Text
                          style={{
                            color: theme.colors.foreground3,
                            fontSize: 14,
                            marginTop: 2,
                          }}
                          numberOfLines={1}>
                          {item.bio}
                        </Text>
                      )}
                    </View>

                    {/* Follow Button (only if not me and I have currentUserId) */}
                    {!isMe && currentUserId && (
                      <Pressable
                        onPress={() => {
                          h('impactLight');
                          followMutation.mutate({
                            targetUserId: item.id,
                            isFollowing: item.is_following || false,
                          });
                        }}
                        style={{
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: item.is_following
                            ? theme.colors.surface
                            : theme.colors.button1,
                          borderWidth: item.is_following ? 1 : 0,
                          borderColor: theme.colors.surfaceBorder,
                        }}>
                        <Text
                          style={{
                            color: item.is_following
                              ? theme.colors.foreground
                              : theme.colors.buttonText1,
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                          {item.is_following ? 'Following' : 'Follow'}
                        </Text>
                      </Pressable>
                    )}
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      </Modal>
      <SharedLookDetailModal
        visible={isSharedLookModalVisible}
        look={selectedSharedLook}
        onClose={() => {
          setIsSharedLookModalVisible(false);
          setSelectedSharedLook(null);
        }}
      />
    </View>
  );
}
