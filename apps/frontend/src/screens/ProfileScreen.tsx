import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Dimensions,
  Pressable,
  Modal,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {useAppTheme} from '../context/ThemeContext';
import {useQuery} from '@tanstack/react-query';
import {useSavedLooks} from '../hooks/useHomeData';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAuth0} from 'react-native-auth0';
import {useUUID} from '../context/UUIDContext';
import {API_BASE_URL} from '../config/api';
import {apiClient} from '../lib/apiClient';
import {useStyleProfile} from '../hooks/useStyleProfile';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import * as Animatable from 'react-native-animatable';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
import {TooltipBubble} from '../components/ToolTip/ToolTip1';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';
import ConnectedAccountsSection from '../components/ConnectedAccounts/ConnectedAccountsSection';
import {
  useFollowers,
  useFollowing,
  useFollowUser,
} from '../hooks/useCommunityApi';
import type {FollowUser} from '../types/community';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {getAccessToken} from '../utils/auth';
import SharedLookDetailModal from '../components/SavedLookModal/SharedLookDetailModal';

const screenWidth = Dimensions.get('window').width;
const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

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

type WardrobeItem = {
  id: string;
  image_url: string;
  name: string;
  favorite?: boolean;
};

type Props = {
  navigate: (screen: string, params?: any) => void;
};

type UserProfile = {
  first_name: string;
  last_name: string;
  email: string;
  profile_picture?: string;
  fashion_level?: string;
  profession?: string;
  bio?: string;
};

export default function ProfileScreen({navigate}: Props) {
  const userId = useUUID();
  const {theme} = useAppTheme();
  const {user} = useAuth0();
  const globalStyles = useGlobalStyles();
  const auth0Sub = user?.sub;
  const {styleProfile} = useStyleProfile(auth0Sub || '');
  const styleTags = styleProfile?.style_preferences || [];

  const [previewVisible, setPreviewVisible] = useState(false);
  const [selectedLook, setSelectedLook] = useState<any | null>(null);
  const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only
  const [hiddenSharedLooks, setHiddenSharedLooks] = useState<Set<string>>(
    new Set(),
  );
  const [isSharedLookModalVisible, setIsSharedLookModalVisible] = useState(false);
  const [selectedSharedLook, setSelectedSharedLook] = useState<any>(null);
  const [bio, setBio] = useState<string>('');
  const [followListModal, setFollowListModal] = useState<
    'followers' | 'following' | null
  >(null);

  // TanStack Query hooks for saved/shared looks
  const {data: savedLooks = [], isLoading: loadingSaved} = useSavedLooks(
    userId || '',
  );

  // Shared looks (community posts by user) - uses different structure than SharedLook type
  const {data: sharedLooks = []} = useQuery<any[]>({
    queryKey: ['sharedLooks', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE_URL}/community/posts/by-user/${userId}?limit=20`,
      );
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60000, // 1 minute
  });

  // Favorite brands query
  const {data: favoriteBrands = []} = useQuery<string[]>({
    queryKey: ['favoriteBrands', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await apiClient.get('/style-profile/brands');
      return Array.isArray(res.data.brands) ? res.data.brands : [];
    },
    staleTime: 60000, // 1 minute
  });

  const HEADER_HEIGHT = 70; // adjust to your actual header height
  const BOTTOM_NAV_HEIGHT = 90; // adjust to your nav height
  const insets = useSafeAreaInsets();

  // ─────────────────────────────────────────────────────────────────────────────
  // Hydrate cached profile picture early
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
      // console.log('[ProfileScreen] Cached profile pic:', cached ? cached.substring(0, 100) : 'NONE');
      // Skip Google default profile pictures - they show the wrong initials
      // when the user has changed their name in the app
      if (cached && !cached.includes('googleusercontent.com')) {
        setProfilePicture(cached);
      }
    })();
  }, [userId]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries: profile, wardrobe, counts
  // ─────────────────────────────────────────────────────────────────────────────
  const {data: userProfileRaw} = useQuery<UserProfile>({
    enabled: !!userId,
    queryKey: ['userProfile', userId],
    queryFn: async () => {
      // console.log('[ProfileScreen] Fetching /users/me for userId:', userId);
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE_URL}/users/me`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      if (!res.ok) throw new Error('Failed to fetch user profile');
      const data = await res.json();
      // console.log('[ProfileScreen] /users/me returned:', {
      //   first_name: data.first_name,
      //   last_name: data.last_name,
      //   email: data.email,
      // });
      return data;
    },
    staleTime: 60000, // 1 minute
  });

  // Fetch community profile for follower/following counts
  const {data: communityProfile} = useQuery<{
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
      if (!res.ok)
        return {followers_count: 0, following_count: 0, posts_count: 0};
      return res.json();
    },
    staleTime: 30000, // 30 seconds
  });

  // Fetch followers/following lists
  const {data: followers = [], isLoading: loadingFollowers} = useFollowers(
    userId || '',
    userId || '',
  );
  const {data: following = [], isLoading: loadingFollowing} = useFollowing(
    userId || '',
    userId || '',
  );
  const followMutation = useFollowUser();

  // Only hydrate picture from backend if we don't already have one locally
  // useEffect(() => {
  //   if (
  //     userProfileRaw &&
  //     !profilePicture &&
  //     userProfileRaw.profile_picture &&
  //     userProfileRaw.profile_picture.trim() !== ''
  //   ) {
  //     setProfilePicture(userProfileRaw.profile_picture);
  //     if (userId) {
  //       AsyncStorage.setItem(
  //         STORAGE_KEY(userId),
  //         userProfileRaw.profile_picture,
  //       ).catch(() => {});
  //     }
  //   }
  // }, [userProfileRaw, profilePicture, userId]);

  // Replace this entire useEffect:
  useEffect(() => {
    if (
      userProfileRaw &&
      userProfileRaw.profile_picture &&
      userProfileRaw.profile_picture.trim() !== ''
    ) {
      // Skip Google default profile pictures - they show the wrong initials/avatar
      // when the user has changed their name in the app
      const pic = userProfileRaw.profile_picture;
      if (pic.includes('googleusercontent.com')) {
        // console.log('[ProfileScreen] Skipping Google profile picture, will use initials');
        return;
      }
      setProfilePicture(pic);
      if (userId) {
        AsyncStorage.setItem(STORAGE_KEY(userId), pic).catch(() => {});
      }
    }
  }, [userProfileRaw, userId]);

  // Set bio from userProfileRaw
  useEffect(() => {
    if (userProfileRaw?.bio) {
      setBio(userProfileRaw.bio);
    }
  }, [userProfileRaw]);

  // IMPORTANT: Don't construct a UserProfile when data is still undefined,
  // or TS will complain about missing required fields.
  const userProfile = userProfileRaw
    ? {
        ...userProfileRaw,
        // never assign null; use undefined or a string
        profile_picture:
          profilePicture || userProfileRaw.profile_picture || undefined,
      }
    : undefined;

  const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
    queryKey: ['wardrobe', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await apiClient.get('/wardrobe');
      return res.data;
    },
    staleTime: 30000, // 30 seconds - shared with ClosetScreen
  });

  const {data: totalFavorites = 0} = useQuery({
    queryKey: ['totalFavorites', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await apiClient.get('/outfit-favorites/count');
      return res.data.count ?? 0;
    },
    staleTime: 30000, // 30 seconds
  });

  const {data: totalCustomOutfits = 0} = useQuery({
    queryKey: ['totalCustomOutfits', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await apiClient.get('/custom-outfits/count');
      return res.data.count ?? 0;
    },
    staleTime: 30000, // 30 seconds
  });

  const totalItems = wardrobe.length;

  // ─────────────────────────────────────────────────────────────────────────────
  // Initials fallback logic
  // ─────────────────────────────────────────────────────────────────────────────
  // // DEBUG: Log what profile data we have
  // console.log('[ProfileScreen] userProfile:', {
  //   userId,
  //   first_name: userProfile?.first_name,
  //   last_name: userProfile?.last_name,
  //   email: userProfile?.email,
  // });

  let initials = '';
  if (userProfile?.first_name || userProfile?.last_name) {
    const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
    const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
    initials = `${f}${l}`;
  } else if (userProfile?.email) {
    const local = userProfile.email.split('@')[0];
    const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
    const f = (parts[0]?.[0] || '').toUpperCase();
    const l = (parts[1]?.[0] || '').toUpperCase();
    initials = f + l || local.slice(0, 2).toUpperCase();
  }

  // // DEBUG: Log the computed initials
  // console.log('[ProfileScreen] INITIALS:', initials, '| profilePicture:', profilePicture ? 'HAS_IMAGE' : 'NO_IMAGE');

  // cache-busted URI so the newest image shows immediately
  const profileUri =
    profilePicture && profilePicture.length > 0
      ? `${profilePicture}${
          profilePicture.includes('?') ? '&' : '?'
        }v=${Date.now()}`
      : '';

  // ─────────────────────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────────────────────
  const styles = StyleSheet.create({
    screen: {
      flex: 1,
      // backgroundColor: theme.colors.background,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
    },
    settingsButton: {
      position: 'absolute',
      bottom: -8,
      right: 16,
      zIndex: 10,
      padding: 8,
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
    linkText: {
      color: theme.colors.button1,
      fontSize: 16,
      marginTop: 4,
    },
  });

  return (
    // <GradientBackground>
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[
        globalStyles.container,
        {
          backgroundColor: theme.colors.background,
          paddingTop: insets.top + HEADER_HEIGHT, // 👈 restore space for header
          paddingBottom: insets.bottom + BOTTOM_NAV_HEIGHT, // 👈 restore space for bottom nav
        },
      ]}>
      <Text style={globalStyles.header}>Profile</Text>

      {/* Settings Icon - moved to GlobalHeader dropdown menu */}
      {/* <AppleTouchFeedback
        style={styles.settingsButton}
        onPress={() => {
          if (global.goingBack) return;
          navigate('Settings', {goBack: () => navigate('Profile')});
        }}
        hapticStyle="impactLight">
        <Animatable.View
          animation="rotate"
          iterationCount="infinite"
          duration={16000}>
          <Icon name="settings" size={26} color={theme.colors.button1} />
        </Animatable.View>
      </AppleTouchFeedback> */}

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
              {profilePicture ? (
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
                <Text style={(styles.statLabel, {color: theme.colors.button1})}>
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
                <Text style={(styles.statLabel, {color: theme.colors.button1})}>
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
          <Text style={styles.nameText}>
            {(userProfile?.first_name || '') +
              ' ' +
              (userProfile?.last_name || '')}
          </Text>
          <Text style={styles.usernameText}>
            @
            {userProfile?.first_name && userProfile?.last_name
              ? `${userProfile.first_name.toLowerCase()}${userProfile.last_name.toLowerCase()}`
              : 'stylhelpr'}
          </Text>
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
          {/* Bio Display (edit in Personal Information screen) */}
          {bio ? (
            <Text style={[styles.bioText, {marginTop: 8}]}>Bio: "{bio}"</Text>
          ) : null}
        </Animatable.View>
      </Animatable.View>

      {/* Style Profile CTA */}
      <Animatable.View
        animation="fadeInUp"
        delay={1400}
        style={globalStyles.section}>
        <Text style={globalStyles.sectionTitle}>Style Profile</Text>
        <View style={{alignItems: 'center'}}>
          <AppleTouchFeedback
            onPress={() => navigate('StyleProfileScreen')}
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
              name="person-outline"
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
              Edit Style Profile
            </Text>
          </AppleTouchFeedback>
        </View>
      </Animatable.View>

      {/* Style Tags */}
      <Animatable.View
        animation="fadeInLeft"
        delay={1600}
        style={globalStyles.sectionScroll}>
        <Text style={globalStyles.sectionTitle}>Style Tags</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{paddingRight: 8}}>
          {styleTags.length === 0 ? (
            <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
              <Text style={globalStyles.missingDataMessage1}>
                No saved styles.
              </Text>
              <TooltipBubble
                message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
                position="top"
              />
            </View>
          ) : (
            styleTags.map((tag, index) => (
              <Animatable.View
                key={tag}
                animation="bounceInRight"
                delay={1700 + index * 80}
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

      {/* Favorite Brands */}
      <Animatable.View
        animation="fadeInRight"
        delay={1900}
        style={globalStyles.sectionScroll}>
        <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{paddingRight: 8}}>
          {favoriteBrands.length === 0 ? (
            <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
              <Text style={globalStyles.missingDataMessage1}>
                No saved brands.
              </Text>
              <TooltipBubble
                message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
                position="top"
              />
            </View>
          ) : (
            favoriteBrands.map((brand, index) => (
              <Animatable.View
                key={brand}
                animation="bounceInLeft"
                delay={2000 + index * 90}
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
        delay={2400}
        style={globalStyles.sectionScroll}>
        <Text style={[globalStyles.sectionTitle]}>Your Shared Styles</Text>
        {sharedLooks.length === 0 ? (
          <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
            <Text style={globalStyles.missingDataMessage1}>
              No shared looks.
            </Text>
            <TooltipBubble
              message="You haven't shared any looks yet. Share an outfit from the home screen to see it here."
              position="top"
            />
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{paddingRight: 8}}>
            {sharedLooks
              .filter(look => !hiddenSharedLooks.has(look.id))
              .map((look, index) => (
                <Animatable.View
                  key={look.id}
                  animation="zoomInUp"
                  delay={2300 + index * 120}
                  useNativeDriver
                  style={[globalStyles.outfitCard]}>
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
                      
                      {/* Hide button */}
                      <Pressable
                        onPress={() => {
                          Alert.alert(
                            'Remove Look',
                            'Are you sure you want to remove this shared look from your feed?',
                            [
                              {text: 'Cancel', style: 'cancel'},
                              {
                                text: 'Remove',
                                style: 'destructive',
                                onPress: () => {
                                  setHiddenSharedLooks(prev =>
                                    new Set(prev).add(look.id),
                                  );
                                },
                              },
                            ],
                          );
                        }}
                        style={{
                           position: 'absolute',
                            top: 4,
                            right: 4,
                            width: 24,
                            height: 24,
                            borderRadius: 50,
                            backgroundColor: 'rgba(0,0,0,0.7)',
                            justifyContent: 'center',
                            alignItems: 'center',
                            // borderWidth: theme.borderWidth.sm, 
                            // borderColor: 'black'
                        }}>
                        <Icon name="close" size={14} color="#fff" />
                      </Pressable>
                    </View>

                    {/* Look name and likes */}
                    <Animatable.View
                      animation="fadeIn"
                      delay={2500 + index * 100}
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

      {/* Connected Accounts */}
      {/* <ConnectedAccountsSection /> */}

      {/* Footer */}
      <Animatable.View
        animation="fadeIn"
        delay={2800}
        style={[globalStyles.section, {paddingTop: 8}]}>
        <AppleTouchFeedback
          hapticStyle="impactLight"
          onPress={() => navigate('ContactScreen')}>
          <Animatable.Text
            animation="pulse"
            iterationCount="infinite"
            duration={5000}
            style={{
              textAlign: 'center',
              color: theme.colors.foreground,
              fontSize: 13,
              paddingVertical: 8,
            }}>
            Contact Support
          </Animatable.Text>
        </AppleTouchFeedback>

        <AppleTouchFeedback
          hapticStyle="impactLight"
          onPress={() => navigate('AboutScreen')}>
          <Animatable.Text
            animation="fadeInUp"
            delay={3000}
            style={{
              textAlign: 'center',
              color: theme.colors.foreground,
              fontSize: 12,
              opacity: 0.8,
              paddingBottom: 16,
            }}>
            About StylHelpr
          </Animatable.Text>
        </AppleTouchFeedback>
      </Animatable.View>

      <SavedLookPreviewModal
        visible={previewVisible}
        look={selectedLook}
        onClose={() => setPreviewVisible(false)}
      />

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
                const isMe = item.id === userId;

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

                    {/* Follow Button (only if not me) */}
                    {!isMe && userId && (
                      <Pressable
                        onPress={() => {
                          h('impactLight');
                          followMutation.mutate({
                            targetUserId: item.id,
                            currentUserId: userId,
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
    </ScrollView>
    // </GradientBackground>
  );
}

///////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
//   Pressable,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';
// import ConnectedAccountsSection from '../components/ConnectedAccounts/ConnectedAccountsSection';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   const HEADER_HEIGHT = 70; // adjust to your actual header height
//   const BOTTOM_NAV_HEIGHT = 90; // adjust to your nav height
//   const insets = useSafeAreaInsets();

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       // backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: -8,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 92,
//       height: 92,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: theme.colors.button1,
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     // <GradientBackground>
//     <ScrollView
//       showsVerticalScrollIndicator={false}
//       contentContainerStyle={[
//         globalStyles.container,
//         {
//           backgroundColor: theme.colors.background,
//           paddingTop: insets.top + HEADER_HEIGHT, // 👈 restore space for header
//           paddingBottom: insets.bottom + BOTTOM_NAV_HEIGHT, // 👈 restore space for bottom nav
//         },
//       ]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => {
//           if (global.goingBack) return;
//           navigate('Settings', {goBack: () => navigate('Profile')});
//         }}
//         hapticStyle="impactLight">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={26} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactLight"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: tokens.fontWeight.medium,
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill2,
//                   {backgroundColor: theme.colors.surface},
//                 ]}>
//                 <Text style={globalStyles.pillText2}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill2,
//                   {backgroundColor: theme.colors.surface},
//                 ]}>
//                 <Text style={globalStyles.pillText2}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2400}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Your Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <Pressable
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[globalStyles.image8]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[
//                       globalStyles.subLabel,
//                       {marginTop: 4, textAlign: 'center'},
//                     ]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </Pressable>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Connected Accounts */}
//       {/* <ConnectedAccountsSection /> */}

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//     // </GradientBackground>
//   );
// }

///////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
//   Pressable,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   const HEADER_HEIGHT = 70; // adjust to your actual header height
//   const BOTTOM_NAV_HEIGHT = 90; // adjust to your nav height
//   const insets = useSafeAreaInsets();

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       // backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: -8,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 92,
//       height: 92,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: theme.colors.button1,
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     // <GradientBackground>
//     <ScrollView
//       contentContainerStyle={[
//         globalStyles.container,
//         {
//           backgroundColor: theme.colors.background,
//           paddingTop: insets.top + HEADER_HEIGHT, // 👈 restore space for header
//           paddingBottom: insets.bottom + BOTTOM_NAV_HEIGHT, // 👈 restore space for bottom nav
//         },
//       ]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => {
//           if (global.goingBack) return;
//           navigate('Settings', {goBack: () => navigate('Profile')});
//         }}
//         hapticStyle="impactLight">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={26} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactLight"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: tokens.fontWeight.medium,
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill2,
//                   {backgroundColor: theme.colors.surface},
//                 ]}>
//                 <Text style={globalStyles.pillText2}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill2,
//                   {backgroundColor: theme.colors.surface},
//                 ]}>
//                 <Text style={globalStyles.pillText2}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Your Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <Pressable
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[globalStyles.image8]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[
//                       globalStyles.subLabel,
//                       {marginTop: 4, textAlign: 'center'},
//                     ]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </Pressable>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//     // </GradientBackground>
//   );
// }

////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
//   Pressable,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       // backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: -8,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 92,
//       height: 92,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.bold,
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: theme.colors.button1,
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     // <GradientBackground>
//     <ScrollView
//       style={[
//         styles.screen,
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => {
//           if (global.goingBack) return;
//           navigate('Settings', {goBack: () => navigate('Profile')});
//         }}
//         hapticStyle="impactLight">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={26} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactLight"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: tokens.fontWeight.medium,
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Your Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <Pressable
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[globalStyles.image8]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[
//                       globalStyles.subLabel,
//                       {marginTop: 4, textAlign: 'center'},
//                     ]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </Pressable>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//     // </GradientBackground>
//   );
// }

/////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
//   Pressable,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       // backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: -8,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 92,
//       height: 92,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: theme.colors.button1,
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     // <GradientBackground>
//     <ScrollView
//       style={[
//         styles.screen,
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => {
//           if (global.goingBack) return;
//           navigate('Settings', {goBack: () => navigate('Profile')});
//         }}
//         hapticStyle="impactMedium">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={26} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <Pressable
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[globalStyles.image8]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.subLabel]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </Pressable>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//     // </GradientBackground>
//   );
// }

//////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 92,
//       height: 92,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={[
//                   globalStyles.pill,
//                   {backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

//////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   // useEffect(() => {
//   //   if (
//   //     userProfileRaw &&
//   //     !profilePicture &&
//   //     userProfileRaw.profile_picture &&
//   //     userProfileRaw.profile_picture.trim() !== ''
//   //   ) {
//   //     setProfilePicture(userProfileRaw.profile_picture);
//   //     if (userId) {
//   //       AsyncStorage.setItem(
//   //         STORAGE_KEY(userId),
//   //         userProfileRaw.profile_picture,
//   //       ).catch(() => {});
//   //     }
//   //   }
//   // }, [userProfileRaw, profilePicture, userId]);

//   // Replace this entire useEffect:
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       console.log(
//         '[PROFILE] Using backend profile picture:',
//         userProfileRaw.profile_picture,
//       );
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

///////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>(''); // keep as string only

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // Only hydrate picture from backend if we don't already have one locally
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       !profilePicture &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       setProfilePicture(userProfileRaw.profile_picture);
//       if (userId) {
//         AsyncStorage.setItem(
//           STORAGE_KEY(userId),
//           userProfileRaw.profile_picture,
//         ).catch(() => {});
//       }
//     }
//   }, [userProfileRaw, profilePicture, userId]);

//   // IMPORTANT: Don't construct a UserProfile when data is still undefined,
//   // or TS will complain about missing required fields.
//   const userProfile = userProfileRaw
//     ? {
//         ...userProfileRaw,
//         // never assign null; use undefined or a string
//         profile_picture:
//           profilePicture || userProfileRaw.profile_picture || undefined,
//       }
//     : undefined;

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // cache-busted URI so the newest image shows immediately
//   const profileUri =
//     profilePicture && profilePicture.length > 0
//       ? `${profilePicture}${
//           profilePicture.includes('?') ? '&' : '?'
//         }v=${Date.now()}`
//       : '';

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profileUri}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

//////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string>('');

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, outfits, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   // ✅ Hydrate profile picture from backend ONLY if not already set
//   useEffect(() => {
//     if (
//       userProfileRaw &&
//       !profilePicture &&
//       userProfileRaw.profile_picture &&
//       userProfileRaw.profile_picture.trim() !== ''
//     ) {
//       setProfilePicture(userProfileRaw.profile_picture);
//       AsyncStorage.setItem(STORAGE_KEY(userId), userProfileRaw.profile_picture);
//     }
//   }, [userProfileRaw, profilePicture, userId]);

//   const userProfile: UserProfile = {
//     ...userProfileRaw,
//     profile_picture: profilePicture || userProfileRaw?.profile_picture || null,
//   };

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profilePicture}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

//////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import AsyncStorage from '@react-native-async-storage/async-storage';

// const screenWidth = Dimensions.get('window').width;
// const STORAGE_KEY = (uid: string) => `profile_picture:${uid}`;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any;

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);
//   const [profilePicture, setProfilePicture] = useState<string | null>(null);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Hydrate cached profile picture early
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       const cached = await AsyncStorage.getItem(STORAGE_KEY(userId));
//       if (cached) {
//         console.log('[PROFILE] Cached profile pic found:', cached);
//         setProfilePicture(cached);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch {
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch {
//       } finally {
//         setLoadingSaved(false);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, outfits, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfileRaw} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//     onSuccess: async data => {
//       // ✅ Only update picture if backend has a valid one
//       if (data?.profile_picture && data.profile_picture.trim() !== '') {
//         setProfilePicture(data.profile_picture);
//         await AsyncStorage.setItem(STORAGE_KEY(userId), data.profile_picture);
//       } else {
//         console.log(
//           '[PROFILE] Server returned no profile picture — keeping cached version',
//         );
//       }
//     },
//   });

//   const userProfile: UserProfile = {
//     ...userProfileRaw,
//     profile_picture: profilePicture || userProfileRaw?.profile_picture || null,
//   };

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {profilePicture ? (
//                 <Image source={{uri: profilePicture}} style={styles.avatar} />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* Footer */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

//////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   ActivityIndicator,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';

// const screenWidth = Dimensions.get('window').width;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any; // kept as in your code

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();

//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands from style_profile table
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;

//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         console.log('👗 Preferred brands (ProfileScreen):', json);
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch (err) {
//         console.error(
//           '❌ Failed to fetch preferred brands in ProfileScreen:',
//           err,
//         );
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     const fetchSavedLooks = async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch (err) {
//         console.error('❌ Failed to fetch saved looks:', err);
//       } finally {
//         setLoadingSaved(false);
//       }
//     };
//     fetchSavedLooks();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, outfits, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfile} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: outfits = []} = useQuery({
//     queryKey: ['outfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/custom-outfits?user_id=${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch outfits');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch total favorites count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       if (!res.ok)
//         throw new Error('Failed to fetch total custom outfits count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {userProfile?.profile_picture ? (
//                 <Image
//                   source={{uri: userProfile.profile_picture}}
//                   style={styles.avatar}
//                 />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved styles.
//               </Text>
//               <TooltipBubble
//                 message='No styles added yet. Tap the "Edit Style Profile" button above and head over
//               there to add your favorite styles.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Brand Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//               <Text style={globalStyles.missingDataMessage1}>
//                 No saved brands.
//               </Text>
//               <TooltipBubble
//                 message='No brands added yet. Tap the "Edit Style Profile" button above and head over
//               there to add your favorite brands.'
//                 position="top"
//               />
//             </View>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <View style={{flexDirection: 'row', alignSelf: 'flex-start'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No saved looks.
//             </Text>
//             <TooltipBubble
//               message='You haven’t saved any looks yet. Tap "Home" in the bottom navigation bar and then tap
//             "Add Look" to add your favorite looks.'
//               position="top"
//             />
//           </View>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* ───────── Profile Footer ───────── */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* Saved Look Preview Modal */}
//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   ActivityIndicator,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';

// const screenWidth = Dimensions.get('window').width;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any; // kept as in your code

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();

//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const styleTags = styleProfile?.style_preferences || [];

//   const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch favorite brands from style_profile table
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;

//     (async () => {
//       try {
//         const res = await fetch(
//           `${API_BASE_URL}/style-profile/${userId}/brands`,
//         );
//         const json = await res.json();
//         console.log('👗 Preferred brands (ProfileScreen):', json);
//         setFavoriteBrands(Array.isArray(json.brands) ? json.brands : []);
//       } catch (err) {
//         console.error(
//           '❌ Failed to fetch preferred brands in ProfileScreen:',
//           err,
//         );
//         setFavoriteBrands([]);
//       }
//     })();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     const fetchSavedLooks = async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch (err) {
//         console.error('❌ Failed to fetch saved looks:', err);
//       } finally {
//         setLoadingSaved(false);
//       }
//     };
//     fetchSavedLooks();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, outfits, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfile} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: outfits = []} = useQuery({
//     queryKey: ['outfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/custom-outfits?user_id=${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch outfits');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch total favorites count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       if (!res.ok)
//         throw new Error('Failed to fetch total custom outfits count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {userProfile?.profile_picture ? (
//                 <Image
//                   source={{uri: userProfile.profile_picture}}
//                   style={styles.avatar}
//                 />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>

//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <Text style={globalStyles.missingDataMessage1}>
//               No style tags added yet. Tap "Edit Style Profile" and head over
//               there to add some.
//             </Text>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Favorite Brands</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <Text style={globalStyles.missingDataMessage1}>
//               No brands added yet. Tap "Edit Style Profile" and head over there
//               to add some.
//             </Text>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <Text style={globalStyles.missingDataMessage1}>
//             You haven’t saved any outfits yet. Head to the Home page and tap
//             "Add Look" to add some.
//           </Text>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* ───────── Profile Footer ───────── */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* Saved Look Preview Modal */}
//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   ActivityIndicator,
//   Dimensions,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';

// const screenWidth = Dimensions.get('window').width;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any; // kept as in your code

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();

//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const favoriteBrands = styleProfile?.preferred_brands || [];
//   const styleTags = styleProfile?.style_preferences || [];

//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Fetch saved looks
//   // ─────────────────────────────────────────────────────────────────────────────
//   useEffect(() => {
//     if (!userId) return;
//     const fetchSavedLooks = async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch (err) {
//         console.error('❌ Failed to fetch saved looks:', err);
//       } finally {
//         setLoadingSaved(false);
//       }
//     };
//     fetchSavedLooks();
//   }, [userId]);

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Queries: profile, wardrobe, outfits, counts
//   // ─────────────────────────────────────────────────────────────────────────────
//   const {data: userProfile} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: outfits = []} = useQuery({
//     queryKey: ['outfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/custom-outfits?user_id=${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch outfits');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch total favorites count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       if (!res.ok)
//         throw new Error('Failed to fetch total custom outfits count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Initials fallback logic
//   // ─────────────────────────────────────────────────────────────────────────────
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // Styles
//   // ─────────────────────────────────────────────────────────────────────────────
//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       {/* Page Header */}
//       {/* <Animatable.Text
//         animation="fadeInDown"
//         delay={200}
//         style={globalStyles.header}>
//         Profile
//       </Animatable.Text> */}

//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings Icon */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Animatable.View
//           animation="rotate"
//           iterationCount="infinite"
//           duration={16000}>
//           <Icon name="settings" size={24} color={theme.colors.button1} />
//         </Animatable.View>
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={300}
//         style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           {/* Avatar */}
//           <Animatable.View
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {userProfile?.profile_picture ? (
//                 <Image
//                   source={{uri: userProfile.profile_picture}}
//                   style={styles.avatar}
//                 />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </Animatable.View>

//           {/* Stats */}
//           <Animatable.View
//             animation="fadeIn"
//             delay={500}
//             style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={600}
//                 style={styles.statNumber}>
//                 {totalItems}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={800}
//                 style={styles.statNumber}>
//                 {totalCustomOutfits}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Animatable.Text
//                 animation="bounceIn"
//                 delay={1000}
//                 style={styles.statNumber}>
//                 {totalFavorites}
//               </Animatable.Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </Animatable.View>
//         </View>

//         {/* Bio Section */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={1200}
//           style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </Animatable.View>
//       </Animatable.View>

//       {/* Style Profile CTA */}
//       <Animatable.View
//         animation="fadeInUp"
//         delay={1400}
//         style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>
//         <View style={{alignItems: 'center'}}>
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </Animatable.View>
//       {/* Style Tags */}
//       <Animatable.View
//         animation="fadeInLeft"
//         delay={1600}
//         style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.length === 0 ? (
//             <Text style={globalStyles.missingDataMessage1}>
//               No style tags added yet. Tap "Edit Style Profile" and head over
//               there to add some.
//             </Text>
//           ) : (
//             styleTags.map((tag, index) => (
//               <Animatable.View
//                 key={tag}
//                 animation="bounceInRight"
//                 delay={1700 + index * 80}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{tag}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Favorite Brands */}
//       <Animatable.View
//         animation="fadeInRight"
//         delay={1900}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Favorite Brands</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.length === 0 ? (
//             <Text style={globalStyles.missingDataMessage1}>
//               No brands added yet. Tap "Edit Style Profile" and head over there
//               to add some.
//             </Text>
//           ) : (
//             favoriteBrands.map((brand, index) => (
//               <Animatable.View
//                 key={brand}
//                 animation="bounceInLeft"
//                 delay={2000 + index * 90}
//                 useNativeDriver
//                 style={globalStyles.pill}>
//                 <Text style={globalStyles.pillText}>#{brand}</Text>
//               </Animatable.View>
//             ))
//           )}
//         </ScrollView>
//       </Animatable.View>

//       {/* Saved Looks */}
//       <Animatable.View
//         animation="fadeInUpBig"
//         delay={2200}
//         style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <Text style={globalStyles.missingDataMessage1}>
//             You haven’t saved any outfits yet. Head to the Home page and tap
//             "Add Look" to add some.
//           </Text>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="zoomInUp"
//                 delay={2300 + index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Animatable.Text
//                     animation="fadeIn"
//                     delay={2500 + index * 100}
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Animatable.Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </Animatable.View>

//       {/* ───────── Profile Footer ───────── */}
//       <Animatable.View
//         animation="fadeIn"
//         delay={2800}
//         style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Animatable.Text
//             animation="pulse"
//             iterationCount="infinite"
//             duration={5000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Animatable.Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Animatable.Text
//             animation="fadeInUp"
//             delay={3000}
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Animatable.Text>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* Saved Look Preview Modal */}
//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

/////////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   ActivityIndicator,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {Dimensions} from 'react-native';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';

// const screenWidth = Dimensions.get('window').width;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any; // kept as in your code

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();

//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const favoriteBrands = styleProfile?.preferred_brands || [];
//   const styleTags = styleProfile?.style_preferences || [];

//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);

//   useEffect(() => {
//     if (!userId) return;
//     const fetchSavedLooks = async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch (err) {
//         console.error('❌ Failed to fetch saved looks:', err);
//       } finally {
//         setLoadingSaved(false);
//       }
//     };
//     fetchSavedLooks();
//   }, [userId]);

//   const {data: userProfile} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: outfits = []} = useQuery({
//     queryKey: ['outfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/custom-outfits?user_id=${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch outfits');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch total favorites count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       if (!res.ok)
//         throw new Error('Failed to fetch total custom outfits count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // 🔤 First + Last initials (fallback to email local-part if needed)
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//     gridRow: {
//       justifyContent: 'space-between',
//       paddingHorizontal: 1,
//     },
//     imageGrid: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'space-between',
//       paddingHorizontal: 1,
//       minHeight: 300,
//     },
//     gridImage: {
//       width: '33.33%',
//       height: 120,
//       marginBottom: 1,
//       backgroundColor: '#000',
//     },
//     profileMenuItem: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius.md,
//       elevation: 1,
//       shadowColor: '#000',
//       shadowOpacity: 0.05,
//       shadowRadius: 4,
//       marginHorizontal: 16,
//     },
//     menuRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     menuText: {
//       fontSize: 17,
//       fontWeight: '500',
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings: subtle haptic on navigation only */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Icon name="settings" size={24} color={theme.colors.button1} />
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <View style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           <View style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {userProfile?.profile_picture ? (
//                 <Image
//                   source={{uri: userProfile.profile_picture}}
//                   style={styles.avatar}
//                 />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </View>
//           <View style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalItems}</Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalCustomOutfits}</Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalFavorites}</Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </View>
//         </View>

//         {/* Name and Bio */}
//         <View style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </View>
//       </View>

//       <View style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>

//         <View style={{alignItems: 'center'}}>
//           {/* Primary action: slightly stronger haptic */}
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//                 marginTop: 4,
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </View>

//       <View style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.map(tag => (
//             <View key={tag} style={globalStyles.pill}>
//               <Text style={globalStyles.pillText}>#{tag}</Text>
//             </View>
//           ))}
//         </ScrollView>
//       </View>

//       <View style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Favorite Brands</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.map(brand => (
//             <View key={brand} style={globalStyles.pill}>
//               <Text style={globalStyles.pillText}>#{brand}</Text>
//             </View>
//           ))}
//         </ScrollView>
//       </View>

//       {/* Saved Looks */}
//       <View style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               paddingLeft: 16,
//               fontStyle: 'italic',
//             }}>
//             You haven’t saved any outfits yet. Tap the heart on your favorite
//             looks!
//           </Text>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="fadeInUp"
//                 delay={index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Text
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </View>

//       {/* ───────── Profile Footer (tiny help link) ───────── */}
//       <View style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Text
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Text
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Text>
//         </AppleTouchFeedback>
//       </View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }

////////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   ScrollView,
//   TouchableOpacity,
//   ActivityIndicator,
// } from 'react-native';
// import {useAppTheme} from '../context/ThemeContext';
// import {useQuery} from '@tanstack/react-query';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {Dimensions} from 'react-native';
// import SavedLookPreviewModal from '../components/SavedLookModal/SavedLookPreviewModal';

// const screenWidth = Dimensions.get('window').width;

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   name: string;
//   favorite?: boolean;
// };

// type SavedOutfit = any; // kept as in your code

// type Props = {
//   navigate: (screen: string) => void;
// };

// type UserProfile = {
//   first_name: string;
//   last_name: string;
//   email: string;
//   profile_picture?: string;
//   fashion_level?: string;
//   profession?: string;
// };

// export default function ProfileScreen({navigate}: Props) {
//   const userId = useUUID();

//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const globalStyles = useGlobalStyles();
//   const auth0Sub = user?.sub;
//   const {styleProfile} = useStyleProfile(auth0Sub || '');
//   const favoriteBrands = styleProfile?.preferred_brands || [];
//   const styleTags = styleProfile?.style_preferences || [];

//   const [savedLooks, setSavedLooks] = useState<any[]>([]);
//   const [loadingSaved, setLoadingSaved] = useState(true);
//   const [previewVisible, setPreviewVisible] = useState(false);
//   const [selectedLook, setSelectedLook] = useState<any | null>(null);

//   useEffect(() => {
//     if (!userId) return;
//     const fetchSavedLooks = async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/saved-looks/${userId}`);
//         if (!res.ok) throw new Error('Failed to fetch saved looks');
//         const data = await res.json();
//         setSavedLooks(data);
//       } catch (err) {
//         console.error('❌ Failed to fetch saved looks:', err);
//       } finally {
//         setLoadingSaved(false);
//       }
//     };
//     fetchSavedLooks();
//   }, [userId]);

//   const {data: userProfile} = useQuery<UserProfile>({
//     enabled: !!userId,
//     queryKey: ['userProfile', userId],
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/users/${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch user profile');
//       return res.json();
//     },
//   });

//   const {data: wardrobe = []} = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${userId}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return res.json();
//     },
//   });

//   const {data: outfits = []} = useQuery({
//     queryKey: ['outfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/custom-outfits?user_id=${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch outfits');
//       return res.json();
//     },
//   });

//   const {data: totalFavorites = 0} = useQuery({
//     queryKey: ['totalFavorites', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(
//         `${API_BASE_URL}/outfit-favorites/count/${userId}`,
//       );
//       if (!res.ok) throw new Error('Failed to fetch total favorites count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const {data: totalCustomOutfits = 0} = useQuery({
//     queryKey: ['totalCustomOutfits', userId],
//     enabled: !!userId,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/custom-outfits/count/${userId}`);
//       if (!res.ok)
//         throw new Error('Failed to fetch total custom outfits count');
//       const data = await res.json();
//       return data.count;
//     },
//   });

//   const totalItems = wardrobe.length;

//   // 🔤 First + Last initials (fallback to email local-part if needed)
//   let initials = '';
//   if (userProfile?.first_name || userProfile?.last_name) {
//     const f = (userProfile?.first_name?.trim?.()[0] || '').toUpperCase();
//     const l = (userProfile?.last_name?.trim?.()[0] || '').toUpperCase();
//     initials = `${f}${l}`;
//   } else if (userProfile?.email) {
//     const local = userProfile.email.split('@')[0];
//     const parts = local.split(/[^a-zA-Z]/).filter(Boolean);
//     const f = (parts[0]?.[0] || '').toUpperCase();
//     const l = (parts[1]?.[0] || '').toUpperCase();
//     initials = f + l || local.slice(0, 2).toUpperCase();
//   }

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     headerRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       marginTop: 10,
//     },
//     settingsButton: {
//       position: 'absolute',
//       bottom: 0,
//       right: 16,
//       zIndex: 10,
//       padding: 8,
//     },
//     avatarWrapper: {
//       marginRight: 20,
//       alignItems: 'center',
//       justifyContent: 'center',
//       marginBottom: 4,
//     },
//     avatarBorder: {
//       width: 100,
//       height: 100,
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.xl,
//       borderColor: theme.colors.surfaceBorder,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     avatar: {
//       width: 90,
//       height: 90,
//       borderRadius: 45,
//       backgroundColor: theme.colors.surface,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     initialsText: {
//       color: theme.colors.foreground,
//       fontWeight: '800',
//       fontSize: 30,
//       letterSpacing: 0.5,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       justifyContent: screenWidth >= 768 ? 'flex-start' : 'space-between',
//       flex: 1,
//     },
//     statBox: {
//       alignItems: 'center',
//       marginRight: screenWidth >= 768 ? 32 : 0,
//     },
//     statNumber: {
//       fontWeight: 'bold',
//       fontSize: 17,
//       color: theme.colors.foreground2,
//     },
//     statLabel: {
//       fontSize: 14,
//       color: theme.colors.foreground3,
//       fontWeight: '600',
//     },
//     bioContainer: {
//       marginTop: 8,
//     },
//     nameText: {
//       color: theme.colors.foreground,
//       fontWeight: '700',
//       fontSize: 17,
//     },
//     bioText: {
//       color: theme.colors.foreground2,
//       fontSize: 16,
//       marginTop: 4,
//       lineHeight: 18,
//     },
//     linkText: {
//       color: '#4ea1f2',
//       fontSize: 16,
//       marginTop: 4,
//     },
//     gridRow: {
//       justifyContent: 'space-between',
//       paddingHorizontal: 1,
//     },
//     imageGrid: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'space-between',
//       paddingHorizontal: 1,
//       minHeight: 300,
//     },
//     gridImage: {
//       width: '33.33%',
//       height: 120,
//       marginBottom: 1,
//       backgroundColor: '#000',
//     },
//     profileMenuItem: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius.md,
//       elevation: 1,
//       shadowColor: '#000',
//       shadowOpacity: 0.05,
//       shadowRadius: 4,
//       marginHorizontal: 16,
//     },
//     menuRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     menuText: {
//       fontSize: 17,
//       fontWeight: '500',
//     },
//   });

//   return (
//     <ScrollView style={[styles.screen, globalStyles.container]}>
//       <Text style={globalStyles.header}>Profile</Text>

//       {/* Settings: subtle haptic on navigation only */}
//       <AppleTouchFeedback
//         style={styles.settingsButton}
//         onPress={() => navigate('Settings')}
//         hapticStyle="selection">
//         <Icon name="settings" size={24} color={theme.colors.button1} />
//       </AppleTouchFeedback>

//       {/* Header Row */}
//       <View style={globalStyles.section}>
//         <View style={styles.headerRow}>
//           <View style={styles.avatarWrapper}>
//             <View style={styles.avatarBorder}>
//               {userProfile?.profile_picture ? (
//                 <Image
//                   source={{uri: userProfile.profile_picture}}
//                   style={styles.avatar}
//                 />
//               ) : (
//                 <View style={styles.avatar}>
//                   <Text style={styles.initialsText}>{initials}</Text>
//                 </View>
//               )}
//             </View>
//           </View>
//           <View style={styles.statsRow}>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalItems}</Text>
//               <Text style={styles.statLabel}>Wardrobe Items</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalCustomOutfits}</Text>
//               <Text style={styles.statLabel}>Outfits</Text>
//             </View>
//             <View style={styles.statBox}>
//               <Text style={styles.statNumber}>{totalFavorites}</Text>
//               <Text style={styles.statLabel}>Favorites</Text>
//             </View>
//           </View>
//         </View>

//         {/* Name and Bio */}
//         <View style={styles.bioContainer}>
//           <Text style={styles.nameText}>
//             {(userProfile?.first_name || '') +
//               ' ' +
//               (userProfile?.last_name || '')}
//           </Text>
//           {userProfile?.fashion_level && (
//             <Text style={styles.bioText}>{userProfile.fashion_level}</Text>
//           )}
//           {userProfile?.profession && (
//             <Text style={styles.bioText}>{userProfile.profession}</Text>
//           )}
//           <Text style={styles.linkText}>{userProfile?.email}</Text>
//         </View>
//       </View>

//       <View style={globalStyles.section}>
//         <Text style={globalStyles.sectionTitle}>Style Profile</Text>

//         <View style={{alignItems: 'center'}}>
//           {/* Primary action: slightly stronger haptic */}
//           <AppleTouchFeedback
//             onPress={() => navigate('StyleProfileScreen')}
//             hapticStyle="impactMedium"
//             style={[
//               globalStyles.buttonPrimary,
//               {
//                 minWidth: 200,
//                 flexDirection: 'row',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//               },
//             ]}>
//             <Icon
//               name="person-outline"
//               size={20}
//               color={theme.colors.buttonText1}
//               style={{marginRight: 8}}
//             />
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 16,
//                 fontWeight: '500',
//                 flexShrink: 1,
//                 textAlign: 'center',
//               }}
//               numberOfLines={1}>
//               Edit Style Profile
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </View>

//       <View style={globalStyles.sectionScroll}>
//         <Text style={globalStyles.sectionTitle}>Style Tags</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {styleTags.map(tag => (
//             <View key={tag} style={globalStyles.pill}>
//               <Text style={globalStyles.pillText}>#{tag}</Text>
//             </View>
//           ))}
//         </ScrollView>
//       </View>

//       <View style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Favorite Brands</Text>
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 8}}>
//           {favoriteBrands.map(brand => (
//             <View key={brand} style={globalStyles.pill}>
//               <Text style={globalStyles.pillText}>#{brand}</Text>
//             </View>
//           ))}
//         </ScrollView>
//       </View>

//       {/* Saved Looks */}
//       <View style={globalStyles.sectionScroll}>
//         <Text style={[globalStyles.sectionTitle]}>Saved Looks</Text>
//         {savedLooks.length === 0 ? (
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               paddingLeft: 16,
//               fontStyle: 'italic',
//             }}>
//             You haven’t saved any outfits yet. Tap the heart on your favorite
//             looks!
//           </Text>
//         ) : (
//           <ScrollView
//             horizontal
//             showsHorizontalScrollIndicator={false}
//             contentContainerStyle={{paddingRight: 8}}>
//             {savedLooks.map((look, index) => (
//               <Animatable.View
//                 key={look.id}
//                 animation="fadeInUp"
//                 delay={index * 120}
//                 useNativeDriver
//                 style={globalStyles.outfitCard}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() => {
//                     setSelectedLook(look);
//                     setPreviewVisible(true);
//                   }}
//                   style={{alignItems: 'center'}}>
//                   <View>
//                     <Image
//                       source={{uri: look.image_url}}
//                       style={[
//                         globalStyles.image4,
//                         {
//                           borderColor: theme.colors.surfaceBorder,
//                           borderWidth: tokens.borderWidth.md,
//                           borderRadius: tokens.borderRadius.md,
//                         },
//                       ]}
//                       resizeMode="cover"
//                     />
//                   </View>
//                   <Text
//                     style={[globalStyles.label, {marginTop: 6}]}
//                     numberOfLines={1}>
//                     {look.name}
//                   </Text>
//                 </AppleTouchFeedback>
//               </Animatable.View>
//             ))}
//           </ScrollView>
//         )}
//       </View>

//       {/* ───────── Profile Footer (tiny help link) ───────── */}
//       <View style={[globalStyles.section, {paddingTop: 8}]}>
//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('ContactScreen')}>
//           <Text
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 13,
//               paddingVertical: 8,
//             }}>
//             Contact Support
//           </Text>
//         </AppleTouchFeedback>

//         <AppleTouchFeedback
//           hapticStyle="impactLight"
//           onPress={() => navigate('AboutScreen')}>
//           <Text
//             style={{
//               textAlign: 'center',
//               color: theme.colors.foreground,
//               fontSize: 12,
//               opacity: 0.8,
//               paddingBottom: 16,
//             }}>
//             About StylHelpr
//           </Text>
//         </AppleTouchFeedback>
//       </View>

//       <SavedLookPreviewModal
//         visible={previewVisible}
//         look={selectedLook}
//         onClose={() => setPreviewVisible(false)}
//       />
//     </ScrollView>
//   );
// }
