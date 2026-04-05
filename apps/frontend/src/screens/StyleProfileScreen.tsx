import React, {useRef, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Animated,
} from 'react-native';
// import LinearGradient from 'react-native-linear-gradient';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../context/ThemeContext';
import BackHeader from '../components/Backheader/Backheader';
import {useProfileProgress} from '../hooks/useProfileProgress';
import {useStyleProfile} from '../hooks/useStyleProfile';
import {useUUID} from '../context/UUIDContext';
import {useQuery} from '@tanstack/react-query';
import {apiClient} from '../lib/apiClient';
import {useAuth0} from 'react-native-auth0';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import type {WardrobeItem} from '../types/wardrobe';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

type Props = {
  navigate: (screen: string) => void;
};

export default function StyleProfileScreen({navigate}: Props) {
  const {user} = useAuth0();
  const auth0Sub = user?.sub;
  const uuid = useUUID();
  const {theme} = useAppTheme();
  const colors = theme.colors;
  const globalStyles = useGlobalStyles();

  const insets = useSafeAreaInsets();

  // ✨ Fade-in for whole screen
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  const styles = StyleSheet.create({
    screen: {
      flex: 1,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    progressLabel: {
      fontSize: 16,
      textAlign: 'left',
      marginTop: 4,
      color: theme.colors.foreground,
    },
    progressBar: {
      height: 8,
      borderRadius: 4,
      backgroundColor: '#ccc',
      overflow: 'hidden',
      marginTop: 8,
      width: '100%',
    },
    progressFill: {
      height: '100%',
      backgroundColor: '#4caf50',
      borderRadius: 4,
    },
    settingsGroup: {
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xxl,
      borderColor: theme.colors.surfaceBorder,
      borderWidth: 1,
      overflow: 'hidden',
    },
    settingsItem: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: '#1c1c1e',
      borderBottomWidth: theme.borderWidth.hairline,
      borderBottomColor: theme.colors.separator2,
    },
    firstItem: {
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
    },
    lastItem: {
      borderBottomWidth: 0,
      borderBottomLeftRadius: 12,
      borderBottomRightRadius: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconBox: {
      width: 32,
      height: 32,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 14,
      backgroundColor: 'rgba(44, 44, 46, 0.9)',
      borderColor: 'rgba(74, 74, 76, 0.9)',
      borderWidth: 1,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 1},
      shadowOpacity: 0.2,
      shadowRadius: 2,
      elevation: 2,
    },
    icon: {
      fontSize: 17,
    },
    label: {
      fontSize: 17,
      color: theme.colors.foreground,
    },
    spacer: {
      flex: 1,
    },
  });

  const {
    styleProfile,
    isLoading: profileLoading,
    isError,
  } = useStyleProfile(uuid || '');

  const {
    data: wardrobe = [],
    isLoading: wardrobeLoading,
    isError: wardrobeError,
  } = useQuery<WardrobeItem[]>({
    queryKey: ['wardrobe', uuid],
    enabled: !!uuid,
    queryFn: async () => {
      const res = await apiClient.get('/wardrobe');
      return res.data;
    },
  });

  // Calculate progress (useProfileProgress is a pure function, not a hook)
  const progress = styleProfile && wardrobe
    ? useProfileProgress(styleProfile, wardrobe)
    : 0;

  // Warning visibility logic: only show when progress < 100
  const showWarning = Number(progress) < 100;

  // All hooks must be called before any conditional returns
  const warnOpacity = useRef(new Animated.Value(1)).current;
  const [warningMounted, setWarningMounted] = useState(true);

  useEffect(() => {
    if (showWarning) {
      setWarningMounted(true);
      Animated.timing(warnOpacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(warnOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished) setWarningMounted(false);
      });
    }
  }, [showWarning, warnOpacity]);

  // Loading state
  if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
      </View>
    );
  }

  // Error state
  if (isError || wardrobeError) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={{color: 'red'}}>Error loading style profile.</Text>
      </View>
    );
  }

  const profileSections = [
    ['Preferences', '🧪', 'Style Preferences'],
    ['Measurements', '📏', 'Measurements'],
    ['SavedMeasurements', '📊', 'Saved Measurements'],
    ['ClothingSizes', '👕', 'Clothing Sizes'],
    ['BudgetAndBrands', '💰', 'Budget & Brands'],
    ['Lifestyle', '🌍', 'Lifestyle'],
    ['Occasions', '📅', 'Occasions'],
    ['BodyTypes', '📐', 'Body Type'],
    ['Proportions', '📊', 'Body Proportions'],
    ['FitPreferences', '🧵', 'Fit Preferences'],
    ['FabricPreferences', '🧶', 'Fabric Preferences'],
    ['FashionGoals', '🎯', 'Fashion Goals'],
    ['StyleIcon', '⭐', 'Style Icons'],
    ['Climate', '🌤️', 'Climate'],
    ['HairColor', '🧑‍🦰', 'Hair Color'],
    ['SkinTone', '🎨', 'Skin Tone'],
    ['EyeColor', '👁️', 'Eye Color'],
    ['ShoppingHabits', '🛍️', 'Shopping Habits'],
    ['PersonalityTraits', '🧠', 'Personality Traits'],
    ['ColorPreferences', '🌈', 'Color Preferences'],
    ['Undertone', '🫧', 'Undertone'],
  ];

  return (
    <Animated.View
      style={[
        globalStyles.container,
        {
          backgroundColor: colors.background,
          opacity: fadeAnim,
        },
      ]}>
      {/* 🧭 Spacer to restore old navbar height */}
      <View
        style={{
          height: insets.top + 60, // ✅ matches GlobalHeader spacing
          backgroundColor: theme.colors.background,
        }}
      />
      <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
        Style Profile
      </Text>

      <View style={globalStyles.section}>
        <View style={globalStyles.backContainer}>
          <BackHeader title="" onBack={() => navigate('Profile')} />
          <Text style={globalStyles.backText}>Back</Text>
        </View>

        <View style={globalStyles.centeredSection}>
          <Text style={styles.progressLabel}>
            Style Profile {progress}% complete
          </Text>
          {/* {__DEV__ && (
            <Text style={{color: '#e94560', fontSize: 10, marginTop: 2}}>
              DEV preferred_brands: type={typeof styleProfile?.preferred_brands}, isArray={String(Array.isArray(styleProfile?.preferred_brands))}, len={styleProfile?.preferred_brands?.length ?? null}, progress={progress}, value={JSON.stringify(styleProfile?.preferred_brands)}
            </Text>
          )} */}

          <View style={styles.progressBar}>
            <View style={[styles.progressFill, {width: `${progress}%`}]} />
          </View>

          {/* 🟣 Get Measured Button */}
          <AppleTouchFeedback
            onPress={() => navigate('MeasurementLiveScreen')}
            hapticStyle="impactMedium"
            style={{
              backgroundColor: theme.colors.button1,
              paddingVertical: 14,
              borderRadius: 12,
              marginTop: 18,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text
              style={{
                color: theme.colors.buttonText1,
                fontSize: 17,
                fontWeight: '600',
              }}>
              Get Measured
            </Text>
          </AppleTouchFeedback>
        </View>
      </View>

      {warningMounted && (
        <Animated.View
          style={{
            opacity: warnOpacity,
            transform: [
              {
                translateY: warnOpacity.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-6, 0],
                }),
              },
            ],
          }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              paddingHorizontal: 28,
              marginBottom: 18,
              marginTop: -8,
            }}>
            <MaterialIcons name="warning" size={32} color="#FFD700" />
            <Text
              style={[
                globalStyles.label,
                {
                  color: theme.colors.foreground,
                  paddingHorizontal: 1,
                  marginLeft: 12,
                },
              ]}>
              Please take a moment to fill out all sections below. Completing
              your Style Profile ensures the most accurate outfit results and
              styling advice.
            </Text>
          </View>
        </Animated.View>
      )}

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={[globalStyles.section, {paddingBottom: 400}]}>
          <View style={globalStyles.centeredSection}>
            <View style={styles.settingsGroup}>
              {profileSections.map(([screen, emoji, label], idx, arr) => {
                const isFirst = idx === 0;
                const isLast = idx === arr.length - 1;
                return (
                  <AppleTouchFeedback
                    key={screen}
                    onPress={() => navigate(screen as string)}
                    hapticStyle="impactLight"
                    style={[
                      styles.settingsItem,
                      isFirst && styles.firstItem,
                      isLast && styles.lastItem,
                      {backgroundColor: theme.colors.surface},
                    ]}>
                    <View style={styles.row}>
                      {/* <LinearGradient
                        colors={['#2f2f2f', '#1f1f1f']}
                        style={styles.iconBox}>
                        <Text style={styles.icon}>{emoji}</Text>
                      </LinearGradient> */}
                      <Text style={styles.label}>{label}</Text>
                      <View style={styles.spacer} />
                      <Icon
                        name="chevron-right"
                        size={22}
                        color={theme.colors.muted}
                        style={{marginTop: 1}}
                      />
                    </View>
                  </AppleTouchFeedback>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

////////////////

// import React, {useRef, useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Animated,
// } from 'react-native';
// // import LinearGradient from 'react-native-linear-gradient';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../context/ThemeContext';
// import BackHeader from '../components/Backheader/Backheader';
// import {useProfileProgress} from '../hooks/useProfileProgress';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import {useUUID} from '../context/UUIDContext';
// import {useQuery} from '@tanstack/react-query';
// import {API_BASE_URL} from '../config/api';
// import {useAuth0} from 'react-native-auth0';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import type {WardrobeItem} from '../types/wardrobe';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

// type Props = {
//   navigate: (screen: string) => void;
// };

// export default function StyleProfileScreen({navigate}: Props) {
//   const {user} = useAuth0();
//   const auth0Sub = user?.sub;
//   const uuid = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const globalStyles = useGlobalStyles();

//   const insets = useSafeAreaInsets();

//   // ✨ Fade-in for whole screen
//   const fadeAnim = useRef(new Animated.Value(0)).current;
//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 700,
//       useNativeDriver: true,
//     }).start();
//   }, [fadeAnim]);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     progressLabel: {
//       fontSize: 16,
//       textAlign: 'left',
//       marginTop: 4,
//       color: theme.colors.foreground,
//     },
//     progressBar: {
//       height: 8,
//       borderRadius: 4,
//       backgroundColor: '#ccc',
//       overflow: 'hidden',
//       marginTop: 8,
//       width: '100%',
//     },
//     progressFill: {
//       height: '100%',
//       backgroundColor: '#4caf50',
//       borderRadius: 4,
//     },
//     settingsGroup: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       borderColor: theme.colors.surfaceBorder,
//       borderWidth: 1,
//       overflow: 'hidden',
//     },
//     settingsItem: {
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: '#1c1c1e',
//       borderBottomWidth: theme.borderWidth.hairline,
//       borderBottomColor: theme.colors.separator2,
//     },
//     firstItem: {
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//     },
//     lastItem: {
//       borderBottomWidth: 0,
//       borderBottomLeftRadius: 12,
//       borderBottomRightRadius: 12,
//     },
//     row: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     iconBox: {
//       width: 32,
//       height: 32,
//       borderRadius: 8,
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginRight: 14,
//       backgroundColor: 'rgba(44, 44, 46, 0.9)',
//       borderColor: 'rgba(74, 74, 76, 0.9)',
//       borderWidth: 1,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.2,
//       shadowRadius: 2,
//       elevation: 2,
//     },
//     icon: {
//       fontSize: 17,
//     },
//     label: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//     },
//     spacer: {
//       flex: 1,
//     },
//   });

//   const {
//     styleProfile,
//     isLoading: profileLoading,
//     isError,
//   } = useStyleProfile(auth0Sub || '');

//   const {
//     data: wardrobe = [],
//     isLoading: wardrobeLoading,
//     isError: wardrobeError,
//   } = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', uuid],
//     enabled: !!uuid,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${uuid}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return await res.json();
//     },
//   });

//   if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color={colors.primary} />
//         <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
//       </View>
//     );
//   }

//   if (isError || wardrobeError) {
//     return (
//       <View style={styles.loadingContainer}>
//         <Text style={{color: 'red'}}>❌ Error loading style profile.</Text>
//       </View>
//     );
//   }

//   let progress = 0;
//   try {
//     progress = useProfileProgress(styleProfile, wardrobe);
//   } catch (e) {
//     // keep as 0 if calculation fails
//   }

//   // ── Warning visibility logic: only show when progress < 100
//   const showWarning = Number(progress) < 100;

//   // Smooth fade-out when reaching 100%, then unmount the block
//   const warnOpacity = useRef(new Animated.Value(showWarning ? 1 : 0)).current;
//   const [warningMounted, setWarningMounted] = useState(showWarning);

//   useEffect(() => {
//     if (showWarning) {
//       setWarningMounted(true);
//       Animated.timing(warnOpacity, {
//         toValue: 1,
//         duration: 250,
//         useNativeDriver: true,
//       }).start();
//     } else {
//       Animated.timing(warnOpacity, {
//         toValue: 0,
//         duration: 250,
//         useNativeDriver: true,
//       }).start(({finished}) => {
//         if (finished) setWarningMounted(false);
//       });
//     }
//   }, [showWarning, warnOpacity]);

//   const profileSections = [
//     ['Preferences', '🧪', 'Style Preferences'],
//     ['SavedMeasurements', '📊', 'Saved Measurements'],
//     ['BudgetAndBrands', '💰', 'Budget & Brands'],
//     ['Appearance', '🧍', 'Appearance'],
//     ['Lifestyle', '🌍', 'Lifestyle'],
//     ['BodyTypes', '📐', 'Body Type'],
//     ['Proportions', '📊', 'Body Proportions'],
//     ['FitPreferences', '🧵', 'Fit Preferences'],
//     ['FashionGoals', '🎯', 'Fashion Goals'],
//     ['Climate', '🌤️', 'Climate'],
//     ['HairColor', '🧑‍🦰', 'Hair Color'],
//     ['SkinTone', '🎨', 'Skin Tone'],
//     ['EyeColor', '👁️', 'Eye Color'],
//     ['ShoppingHabits', '🛍️', 'Shopping Habits'],
//     ['PersonalityTraits', '🧠', 'Personality Traits'],
//     ['ColorPreferences', '🌈', 'Color Preferences'],
//     ['Undertone', '🫧', 'Undertone'],
//     ['StyleKeywords', '🪞', 'Style Keywords'],
//   ];

//   return (
//     <Animated.View
//       style={[
//         globalStyles.container,
//         {
//           backgroundColor: colors.background,
//           opacity: fadeAnim,
//         },
//       ]}>
//       {/* 🧭 Spacer to restore old navbar height */}
//       <View
//         style={{
//           height: insets.top + 60, // ✅ matches GlobalHeader spacing
//           backgroundColor: theme.colors.background,
//         }}
//       />
//       <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
//         Style Profile
//       </Text>

//       <View style={globalStyles.section}>
//         <View style={globalStyles.backContainer}>
//           <BackHeader title="" onBack={() => navigate('Profile')} />
//           <Text style={globalStyles.backText}>Back</Text>
//         </View>

//         <View style={globalStyles.centeredSection}>
//           <Text style={styles.progressLabel}>
//             Style Profile {progress}% complete
//           </Text>

//           <View style={styles.progressBar}>
//             <View style={[styles.progressFill, {width: `${progress}%`}]} />
//           </View>

//           {/* 🟣 Get Measured Button */}
//           <AppleTouchFeedback
//             onPress={() => navigate('MeasurementLiveScreen')}
//             hapticStyle="impactMedium"
//             style={{
//               backgroundColor: theme.colors.button1,
//               paddingVertical: 14,
//               borderRadius: 12,
//               marginTop: 18,
//               alignItems: 'center',
//               justifyContent: 'center',
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.buttonText1,
//                 fontSize: 17,
//                 fontWeight: '600',
//               }}>
//               Get Measured
//             </Text>
//           </AppleTouchFeedback>
//         </View>
//       </View>

//       {warningMounted && (
//         <Animated.View
//           style={{
//             opacity: warnOpacity,
//             transform: [
//               {
//                 translateY: warnOpacity.interpolate({
//                   inputRange: [0, 1],
//                   outputRange: [-6, 0],
//                 }),
//               },
//             ],
//           }}>
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               alignItems: 'center',
//               paddingHorizontal: 28,
//               marginBottom: 18,
//               marginTop: -8,
//             }}>
//             <MaterialIcons name="warning" size={32} color="#FFD700" />
//             <Text
//               style={[
//                 globalStyles.label,
//                 {
//                   color: theme.colors.foreground,
//                   paddingHorizontal: 1,
//                   marginLeft: 12,
//                 },
//               ]}>
//               Please take a moment to fill out all sections below. Completing
//               your Style Profile ensures the most accurate outfit results and
//               styling advice.
//             </Text>
//           </View>
//         </Animated.View>
//       )}

//       <ScrollView showsVerticalScrollIndicator={false}>
//         <View style={[globalStyles.section, {paddingBottom: 350}]}>
//           <View style={globalStyles.centeredSection}>
//             <View style={styles.settingsGroup}>
//               {profileSections.map(([screen, emoji, label], idx, arr) => {
//                 const isFirst = idx === 0;
//                 const isLast = idx === arr.length - 1;
//                 return (
//                   <AppleTouchFeedback
//                     key={screen}
//                     onPress={() => navigate(screen as string)}
//                     hapticStyle="impactLight"
//                     style={[
//                       styles.settingsItem,
//                       isFirst && styles.firstItem,
//                       isLast && styles.lastItem,
//                       {backgroundColor: theme.colors.surface},
//                     ]}>
//                     <View style={styles.row}>
//                       {/* <LinearGradient
//                         colors={['#2f2f2f', '#1f1f1f']}
//                         style={styles.iconBox}>
//                         <Text style={styles.icon}>{emoji}</Text>
//                       </LinearGradient> */}
//                       <Text style={styles.label}>{label}</Text>
//                       <View style={styles.spacer} />
//                       <Icon
//                         name="chevron-right"
//                         size={22}
//                         color={theme.colors.muted}
//                         style={{marginTop: 1}}
//                       />
//                     </View>
//                   </AppleTouchFeedback>
//                 );
//               })}
//             </View>
//           </View>
//         </View>
//       </ScrollView>
//     </Animated.View>
//   );
// }

//////////////////

// import React, {useRef, useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Animated,
// } from 'react-native';
// // import LinearGradient from 'react-native-linear-gradient';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../context/ThemeContext';
// import BackHeader from '../components/Backheader/Backheader';
// import {useProfileProgress} from '../hooks/useProfileProgress';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import {useUUID} from '../context/UUIDContext';
// import {useQuery} from '@tanstack/react-query';
// import {API_BASE_URL} from '../config/api';
// import {useAuth0} from 'react-native-auth0';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import type {WardrobeItem} from '../types/wardrobe';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

// type Props = {
//   navigate: (screen: string) => void;
// };

// export default function StyleProfileScreen({navigate}: Props) {
//   const {user} = useAuth0();
//   const auth0Sub = user?.sub;
//   const uuid = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const globalStyles = useGlobalStyles();

//   const insets = useSafeAreaInsets();

//   // ✨ Fade-in for whole screen
//   const fadeAnim = useRef(new Animated.Value(0)).current;
//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 700,
//       useNativeDriver: true,
//     }).start();
//   }, [fadeAnim]);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     progressLabel: {
//       fontSize: 16,
//       textAlign: 'left',
//       marginTop: 4,
//       color: theme.colors.foreground,
//     },
//     progressBar: {
//       height: 8,
//       borderRadius: 4,
//       backgroundColor: '#ccc',
//       overflow: 'hidden',
//       marginTop: 8,
//       width: '100%',
//     },
//     progressFill: {
//       height: '100%',
//       backgroundColor: '#4caf50',
//       borderRadius: 4,
//     },
//     settingsGroup: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       marginTop: 16,
//       borderColor: theme.colors.surfaceBorder,
//       borderWidth: 1,
//       overflow: 'hidden',
//     },
//     settingsItem: {
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: '#1c1c1e',
//       borderBottomWidth: theme.borderWidth.hairline,
//       borderBottomColor: theme.colors.separator2,
//     },
//     firstItem: {
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//     },
//     lastItem: {
//       borderBottomWidth: 0,
//       borderBottomLeftRadius: 12,
//       borderBottomRightRadius: 12,
//     },
//     row: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     iconBox: {
//       width: 32,
//       height: 32,
//       borderRadius: 8,
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginRight: 14,
//       backgroundColor: 'rgba(44, 44, 46, 0.9)',
//       borderColor: 'rgba(74, 74, 76, 0.9)',
//       borderWidth: 1,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.2,
//       shadowRadius: 2,
//       elevation: 2,
//     },
//     icon: {
//       fontSize: 17,
//     },
//     label: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//     },
//     spacer: {
//       flex: 1,
//     },
//   });

//   const {
//     styleProfile,
//     isLoading: profileLoading,
//     isError,
//   } = useStyleProfile(auth0Sub || '');

//   const {
//     data: wardrobe = [],
//     isLoading: wardrobeLoading,
//     isError: wardrobeError,
//   } = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', uuid],
//     enabled: !!uuid,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${uuid}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return await res.json();
//     },
//   });

//   if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color={colors.primary} />
//         <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
//       </View>
//     );
//   }

//   if (isError || wardrobeError) {
//     return (
//       <View style={styles.loadingContainer}>
//         <Text style={{color: 'red'}}>❌ Error loading style profile.</Text>
//       </View>
//     );
//   }

//   let progress = 0;
//   try {
//     progress = useProfileProgress(styleProfile, wardrobe);
//   } catch (e) {
//     // keep as 0 if calculation fails
//   }

//   // ── Warning visibility logic: only show when progress < 100
//   const showWarning = Number(progress) < 100;

//   // Smooth fade-out when reaching 100%, then unmount the block
//   const warnOpacity = useRef(new Animated.Value(showWarning ? 1 : 0)).current;
//   const [warningMounted, setWarningMounted] = useState(showWarning);

//   useEffect(() => {
//     if (showWarning) {
//       setWarningMounted(true);
//       Animated.timing(warnOpacity, {
//         toValue: 1,
//         duration: 250,
//         useNativeDriver: true,
//       }).start();
//     } else {
//       Animated.timing(warnOpacity, {
//         toValue: 0,
//         duration: 250,
//         useNativeDriver: true,
//       }).start(({finished}) => {
//         if (finished) setWarningMounted(false);
//       });
//     }
//   }, [showWarning, warnOpacity]);

//   const profileSections = [
//     ['Preferences', '🧪', 'Style Preferences'],
//     ['Measurements', '📏', 'Measurements'],
//     ['BudgetAndBrands', '💰', 'Budget & Brands'],
//     ['Appearance', '🧍', 'Appearance'],
//     ['Lifestyle', '🌍', 'Lifestyle'],
//     ['BodyTypes', '📐', 'Body Type'],
//     ['Proportions', '📊', 'Body Proportions'],
//     ['FitPreferences', '🧵', 'Fit Preferences'],
//     ['FashionGoals', '🎯', 'Fashion Goals'],
//     ['Climate', '🌤️', 'Climate'],
//     ['HairColor', '🧑‍🦰', 'Hair Color'],
//     ['SkinTone', '🎨', 'Skin Tone'],
//     ['EyeColor', '👁️', 'Eye Color'],
//     ['ShoppingHabits', '🛍️', 'Shopping Habits'],
//     ['PersonalityTraits', '🧠', 'Personality Traits'],
//     ['ColorPreferences', '🌈', 'Color Preferences'],
//     ['Undertone', '🫧', 'Undertone'],
//     ['StyleKeywords', '🪞', 'Style Keywords'],
//   ];

//   return (
//     <Animated.View
//       style={[
//         globalStyles.container,
//         {
//           backgroundColor: colors.background,
//           opacity: fadeAnim,
//         },
//       ]}>
//       {/* 🧭 Spacer to restore old navbar height */}
//       <View
//         style={{
//           height: insets.top + 60, // ✅ matches GlobalHeader spacing
//           backgroundColor: theme.colors.background,
//         }}
//       />
//       <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
//         Style Profile
//       </Text>

//       <View style={globalStyles.section}>
//         <View style={globalStyles.backContainer}>
//           <BackHeader title="" onBack={() => navigate('Profile')} />
//           <Text style={globalStyles.backText}>Back</Text>
//         </View>

//         <View style={globalStyles.centeredSection}>
//           <Text style={styles.progressLabel}>
//             Style Profile {progress}% complete
//           </Text>
//           <View style={styles.progressBar}>
//             <View style={[styles.progressFill, {width: `${progress}%`}]} />
//           </View>
//         </View>
//       </View>

//       {warningMounted && (
//         <Animated.View
//           style={{
//             opacity: warnOpacity,
//             transform: [
//               {
//                 translateY: warnOpacity.interpolate({
//                   inputRange: [0, 1],
//                   outputRange: [-6, 0],
//                 }),
//               },
//             ],
//           }}>
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               alignItems: 'center',
//               paddingHorizontal: 28,
//               marginBottom: 18,
//               marginTop: -8,
//             }}>
//             <MaterialIcons name="warning" size={32} color="#FFD700" />
//             <Text
//               style={[
//                 globalStyles.label,
//                 {
//                   color: theme.colors.foreground,
//                   paddingHorizontal: 1,
//                   marginLeft: 12,
//                 },
//               ]}>
//               Please take a moment to fill out all sections below. Completing
//               your Style Profile ensures the most accurate outfit results and
//               styling advice.
//             </Text>
//           </View>
//         </Animated.View>
//       )}

//       <ScrollView>
//         <View style={[globalStyles.section, {paddingBottom: 300}]}>
//           <View style={globalStyles.centeredSection}>
//             <View style={styles.settingsGroup}>
//               {profileSections.map(([screen, emoji, label], idx, arr) => {
//                 const isFirst = idx === 0;
//                 const isLast = idx === arr.length - 1;
//                 return (
//                   <AppleTouchFeedback
//                     key={screen}
//                     onPress={() => navigate(screen as string)}
//                     hapticStyle="impactLight"
//                     style={[
//                       styles.settingsItem,
//                       isFirst && styles.firstItem,
//                       isLast && styles.lastItem,
//                       {backgroundColor: theme.colors.surface},
//                     ]}>
//                     <View style={styles.row}>
//                       {/* <LinearGradient
//                         colors={['#2f2f2f', '#1f1f1f']}
//                         style={styles.iconBox}>
//                         <Text style={styles.icon}>{emoji}</Text>
//                       </LinearGradient> */}
//                       <Text style={styles.label}>{label}</Text>
//                       <View style={styles.spacer} />
//                       <Icon
//                         name="chevron-right"
//                         size={22}
//                         color={theme.colors.muted}
//                         style={{marginTop: 1}}
//                       />
//                     </View>
//                   </AppleTouchFeedback>
//                 );
//               })}
//             </View>
//           </View>
//         </View>
//       </ScrollView>
//     </Animated.View>
//   );
// }

//////////////////////

// import React, {useRef, useEffect, useState} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Animated,
// } from 'react-native';
// // import LinearGradient from 'react-native-linear-gradient';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../context/ThemeContext';
// import BackHeader from '../components/Backheader/Backheader';
// import {useProfileProgress} from '../hooks/useProfileProgress';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import {useUUID} from '../context/UUIDContext';
// import {useQuery} from '@tanstack/react-query';
// import {API_BASE_URL} from '../config/api';
// import {useAuth0} from 'react-native-auth0';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import type {WardrobeItem} from '../types/wardrobe';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

// type Props = {
//   navigate: (screen: string) => void;
// };

// export default function StyleProfileScreen({navigate}: Props) {
//   const {user} = useAuth0();
//   const auth0Sub = user?.sub;
//   const uuid = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const globalStyles = useGlobalStyles();

//   // ✨ Fade-in for whole screen
//   const fadeAnim = useRef(new Animated.Value(0)).current;
//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 700,
//       useNativeDriver: true,
//     }).start();
//   }, [fadeAnim]);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     progressLabel: {
//       fontSize: 16,
//       textAlign: 'left',
//       marginTop: 4,
//       color: theme.colors.foreground,
//     },
//     progressBar: {
//       height: 8,
//       borderRadius: 4,
//       backgroundColor: '#ccc',
//       overflow: 'hidden',
//       marginTop: 8,
//       width: '100%',
//     },
//     progressFill: {
//       height: '100%',
//       backgroundColor: '#4caf50',
//       borderRadius: 4,
//     },
//     settingsGroup: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: 12,
//       marginTop: 16,
//       borderColor: theme.colors.surfaceBorder,
//       borderWidth: 1,
//       overflow: 'hidden',
//     },
//     settingsItem: {
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: '#1c1c1e',
//       borderBottomWidth: theme.borderWidth.hairline,
//       borderBottomColor: theme.colors.separator2,
//     },
//     firstItem: {
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//     },
//     lastItem: {
//       borderBottomWidth: 0,
//       borderBottomLeftRadius: 12,
//       borderBottomRightRadius: 12,
//     },
//     row: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     iconBox: {
//       width: 32,
//       height: 32,
//       borderRadius: 8,
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginRight: 14,
//       backgroundColor: 'rgba(44, 44, 46, 0.9)',
//       borderColor: 'rgba(74, 74, 76, 0.9)',
//       borderWidth: 1,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.2,
//       shadowRadius: 2,
//       elevation: 2,
//     },
//     icon: {
//       fontSize: 17,
//     },
//     label: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//     },
//     spacer: {
//       flex: 1,
//     },
//   });

//   const {
//     styleProfile,
//     isLoading: profileLoading,
//     isError,
//   } = useStyleProfile(auth0Sub || '');

//   const {
//     data: wardrobe = [],
//     isLoading: wardrobeLoading,
//     isError: wardrobeError,
//   } = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', uuid],
//     enabled: !!uuid,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${uuid}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return await res.json();
//     },
//   });

//   if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color={colors.primary} />
//         <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
//       </View>
//     );
//   }

//   if (isError || wardrobeError) {
//     return (
//       <View style={styles.loadingContainer}>
//         <Text style={{color: 'red'}}>❌ Error loading style profile.</Text>
//       </View>
//     );
//   }

//   let progress = 0;
//   try {
//     progress = useProfileProgress(styleProfile, wardrobe);
//   } catch (e) {
//     // keep as 0 if calculation fails
//   }

//   // ── Warning visibility logic: only show when progress < 100
//   const showWarning = Number(progress) < 100;

//   // Smooth fade-out when reaching 100%, then unmount the block
//   const warnOpacity = useRef(new Animated.Value(showWarning ? 1 : 0)).current;
//   const [warningMounted, setWarningMounted] = useState(showWarning);

//   useEffect(() => {
//     if (showWarning) {
//       setWarningMounted(true);
//       Animated.timing(warnOpacity, {
//         toValue: 1,
//         duration: 250,
//         useNativeDriver: true,
//       }).start();
//     } else {
//       Animated.timing(warnOpacity, {
//         toValue: 0,
//         duration: 250,
//         useNativeDriver: true,
//       }).start(({finished}) => {
//         if (finished) setWarningMounted(false);
//       });
//     }
//   }, [showWarning, warnOpacity]);

//   const profileSections = [
//     ['Preferences', '🧪', 'Style Preferences'],
//     ['Measurements', '📏', 'Measurements'],
//     ['BudgetAndBrands', '💰', 'Budget & Brands'],
//     ['Appearance', '🧍', 'Appearance'],
//     ['Lifestyle', '🌍', 'Lifestyle'],
//     ['BodyTypes', '📐', 'Body Type'],
//     ['Proportions', '📊', 'Body Proportions'],
//     ['FitPreferences', '🧵', 'Fit Preferences'],
//     ['FashionGoals', '🎯', 'Fashion Goals'],
//     ['Climate', '🌤️', 'Climate'],
//     ['HairColor', '🧑‍🦰', 'Hair Color'],
//     ['SkinTone', '🎨', 'Skin Tone'],
//     ['EyeColor', '👁️', 'Eye Color'],
//     ['ShoppingHabits', '🛍️', 'Shopping Habits'],
//     ['PersonalityTraits', '🧠', 'Personality Traits'],
//     ['ColorPreferences', '🌈', 'Color Preferences'],
//     ['Undertone', '🫧', 'Undertone'],
//     ['StyleKeywords', '🪞', 'Style Keywords'],
//   ];

//   return (
//     <Animated.View
//       style={[
//         globalStyles.container,
//         {backgroundColor: colors.background, opacity: fadeAnim},
//       ]}>
//       <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
//         Style Profile
//       </Text>

//       <View style={globalStyles.section}>
//         <View style={globalStyles.backContainer}>
//           <BackHeader title="" onBack={() => navigate('Profile')} />
//           <Text style={globalStyles.backText}>Back</Text>
//         </View>

//         <View style={globalStyles.centeredSection}>
//           <Text style={styles.progressLabel}>
//             Style Profile {progress}% complete
//           </Text>
//           <View style={styles.progressBar}>
//             <View style={[styles.progressFill, {width: `${progress}%`}]} />
//           </View>
//         </View>
//       </View>

//       {warningMounted && (
//         <Animated.View
//           style={{
//             opacity: warnOpacity,
//             transform: [
//               {
//                 translateY: warnOpacity.interpolate({
//                   inputRange: [0, 1],
//                   outputRange: [-6, 0],
//                 }),
//               },
//             ],
//           }}>
//           <View
//             style={{
//               flexDirection: 'row',
//               justifyContent: 'center',
//               alignItems: 'center',
//               paddingHorizontal: 28,
//               marginBottom: 18,
//               marginTop: -8,
//             }}>
//             <MaterialIcons name="warning" size={32} color="#FFD700" />
//             <Text
//               style={[
//                 globalStyles.label,
//                 {
//                   color: theme.colors.foreground,
//                   paddingHorizontal: 1,
//                   marginLeft: 12,
//                 },
//               ]}>
//               Please take a moment to fill out all sections below. Completing
//               your Style Profile ensures the most accurate outfit results and
//               styling advice.
//             </Text>
//           </View>
//         </Animated.View>
//       )}

//       <ScrollView>
//         <View style={[globalStyles.section, {paddingBottom: 200}]}>
//           <View style={globalStyles.centeredSection}>
//             <View style={styles.settingsGroup}>
//               {profileSections.map(([screen, emoji, label], idx, arr) => {
//                 const isFirst = idx === 0;
//                 const isLast = idx === arr.length - 1;
//                 return (
//                   <AppleTouchFeedback
//                     key={screen}
//                     onPress={() => navigate(screen as string)}
//                     hapticStyle="impactMedium"
//                     style={[
//                       styles.settingsItem,
//                       isFirst && styles.firstItem,
//                       isLast && styles.lastItem,
//                       {backgroundColor: theme.colors.surface},
//                     ]}>
//                     <View style={styles.row}>
//                       <Text style={styles.label}>{label}</Text>
//                       <View style={styles.spacer} />
//                       <Icon
//                         name="chevron-right"
//                         size={22}
//                         color={theme.colors.muted}
//                         style={{marginTop: 1}}
//                       />
//                     </View>
//                   </AppleTouchFeedback>
//                 );
//               })}
//             </View>
//           </View>
//         </View>
//       </ScrollView>
//     </Animated.View>
//   );
// }

/////////////////

// import React, {useRef, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Animated,
// } from 'react-native';
// import LinearGradient from 'react-native-linear-gradient';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../context/ThemeContext';
// import BackHeader from '../components/Backheader/Backheader';
// import {useProfileProgress} from '../hooks/useProfileProgress';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import {useUUID} from '../context/UUIDContext';
// import {useQuery} from '@tanstack/react-query';
// import {API_BASE_URL} from '../config/api';
// import {useAuth0} from 'react-native-auth0';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import type {WardrobeItem} from '../types/wardrobe';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

// type Props = {
//   navigate: (screen: string) => void;
// };

// export default function StyleProfileScreen({navigate}: Props) {
//   const {user} = useAuth0();
//   const auth0Sub = user?.sub;
//   const uuid = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const globalStyles = useGlobalStyles();

//   // ✨ Fade-in animation
//   const fadeAnim = useRef(new Animated.Value(0)).current;
//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 700,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     progressLabel: {
//       fontSize: 16,
//       textAlign: 'left',
//       marginTop: 4,
//       color: theme.colors.foreground,
//     },
//     progressBar: {
//       height: 8,
//       borderRadius: 4,
//       backgroundColor: '#ccc',
//       overflow: 'hidden',
//       marginTop: 8,
//       width: '100%',
//     },
//     progressFill: {
//       height: '100%',
//       backgroundColor: '#4caf50',
//       borderRadius: 4,
//     },
//     settingsGroup: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: 12,
//       marginTop: 16,
//       borderColor: theme.colors.surfaceBorder,
//       borderWidth: 1,
//       overflow: 'hidden',
//     },
//     settingsItem: {
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: '#1c1c1e',
//       borderBottomWidth: 1,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     firstItem: {
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//     },
//     lastItem: {
//       borderBottomWidth: 0,
//       borderBottomLeftRadius: 12,
//       borderBottomRightRadius: 12,
//     },
//     row: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     iconBox: {
//       width: 32,
//       height: 32,
//       borderRadius: 8,
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginRight: 14,
//       backgroundColor: 'rgba(44, 44, 46, 0.9)',
//       borderColor: 'rgba(74, 74, 76, 0.9)',
//       borderWidth: 1,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.2,
//       shadowRadius: 2,
//       elevation: 2,
//     },
//     icon: {
//       fontSize: 17,
//     },
//     label: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//     },
//     spacer: {
//       flex: 1,
//     },
//   });

//   const {
//     styleProfile,
//     isLoading: profileLoading,
//     isError,
//   } = useStyleProfile(auth0Sub || '');

//   const {
//     data: wardrobe = [],
//     isLoading: wardrobeLoading,
//     isError: wardrobeError,
//   } = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', uuid],
//     enabled: !!uuid,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${uuid}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return await res.json();
//     },
//   });

//   if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color={colors.primary} />
//         <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
//       </View>
//     );
//   }

//   if (isError || wardrobeError) {
//     return (
//       <View style={styles.loadingContainer}>
//         <Text style={{color: 'red'}}>❌ Error loading style profile.</Text>
//       </View>
//     );
//   }

//   let progress = 0;
//   try {
//     progress = useProfileProgress(styleProfile, wardrobe);
//   } catch (e) {}

//   const profileSections = [
//     ['Preferences', '🧪', 'Style Preferences'],
//     ['Measurements', '📏', 'Measurements'],
//     ['BudgetAndBrands', '💰', 'Budget & Brands'],
//     ['Appearance', '🧍', 'Appearance'],
//     ['Lifestyle', '🌍', 'Lifestyle'],
//     ['BodyTypes', '📐', 'Body Type'],
//     ['Proportions', '📊', 'Body Proportions'],
//     ['FitPreferences', '🧵', 'Fit Preferences'],
//     ['FashionGoals', '🎯', 'Fashion Goals'],
//     ['Climate', '🌤️', 'Climate'],
//     ['HairColor', '🧑‍🦰', 'Hair Color'],
//     ['SkinTone', '🎨', 'Skin Tone'],
//     ['EyeColor', '👁️', 'Eye Color'],
//     ['ShoppingHabits', '🛍️', 'Shopping Habits'],
//     ['PersonalityTraits', '🧠', 'Personality Traits'],
//     ['ColorPreferences', '🌈', 'Color Preferences'],
//     ['Undertone', '🫧', 'Undertone'],
//     ['StyleKeywords', '🪞', 'Style Keywords'],
//   ];

//   return (
//     <Animated.View
//       style={[
//         globalStyles.container,
//         {backgroundColor: colors.background, opacity: fadeAnim},
//       ]}>
//       <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
//         Style Profile
//       </Text>

//       <View style={globalStyles.section}>
//         <View style={globalStyles.backContainer}>
//           <BackHeader title="" onBack={() => navigate('Profile')} />
//           <Text style={globalStyles.backText}>Back</Text>
//         </View>

//         <View style={globalStyles.centeredSection}>
//           <Text style={styles.progressLabel}>
//             Style Profile {progress}% complete
//           </Text>
//           <View style={styles.progressBar}>
//             <View style={[styles.progressFill, {width: `${progress}%`}]} />
//           </View>
//         </View>
//       </View>

//       <View
//         style={{
//           flexDirection: 'row',
//           justifyContent: 'center',
//           alignItems: 'center',
//           paddingHorizontal: 28,
//           marginBottom: 18,
//           marginTop: -8,
//         }}>
//         <MaterialIcons name="warning" size={32} color="#FFD700" />
//         <Text
//           style={[
//             globalStyles.label,
//             {
//               color: theme.colors.foreground,
//               paddingHorizontal: 1,
//               marginLeft: 12,
//             },
//           ]}>
//           Please spend a moment and go through fill out all the information
//           below. This will help drive accurate and optimal outfit results and
//           styling advice!
//         </Text>
//       </View>

//       <ScrollView>
//         <View style={[globalStyles.section, {paddingBottom: 200}]}>
//           <View style={globalStyles.centeredSection}>
//             <View style={styles.settingsGroup}>
//               {profileSections.map(([screen, emoji, label], idx, arr) => {
//                 const isFirst = idx === 0;
//                 const isLast = idx === arr.length - 1;
//                 return (
//                   <AppleTouchFeedback
//                     key={screen}
//                     onPress={() => navigate(screen as string)}
//                     hapticStyle="impactMedium"
//                     style={[
//                       styles.settingsItem,
//                       isFirst && styles.firstItem,
//                       isLast && styles.lastItem,
//                       {backgroundColor: theme.colors.surface},
//                     ]}>
//                     <View style={styles.row}>
//                       <LinearGradient
//                         colors={['#2f2f2f', '#1f1f1f']}
//                         style={styles.iconBox}>
//                         <Text style={styles.icon}>{emoji}</Text>
//                       </LinearGradient>
//                       <Text style={styles.label}>{label}</Text>
//                       <View style={styles.spacer} />
//                       <Icon
//                         name="chevron-right"
//                         size={22}
//                         color={theme.colors.muted}
//                         style={{marginTop: 1}}
//                       />
//                     </View>
//                   </AppleTouchFeedback>
//                 );
//               })}
//             </View>
//           </View>
//         </View>
//       </ScrollView>
//     </Animated.View>
//   );
// }

////////////////////

// import React from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
// } from 'react-native';
// import LinearGradient from 'react-native-linear-gradient';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../context/ThemeContext';
// import BackHeader from '../components/Backheader/Backheader';
// import {useProfileProgress} from '../hooks/useProfileProgress';
// import {useStyleProfile} from '../hooks/useStyleProfile';
// import {useUUID} from '../context/UUIDContext';
// import {useQuery} from '@tanstack/react-query';
// import {API_BASE_URL} from '../config/api';
// import {useAuth0} from 'react-native-auth0';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import type {WardrobeItem} from '../types/wardrobe';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';

// type Props = {
//   navigate: (screen: string) => void;
// };

// export default function StyleProfileScreen({navigate}: Props) {
//   const {user} = useAuth0();
//   const auth0Sub = user?.sub;
//   const uuid = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     progressLabel: {
//       fontSize: 16,
//       textAlign: 'left',
//       marginTop: 4,
//       color: theme.colors.foreground,
//     },
//     progressBar: {
//       height: 8,
//       borderRadius: 4,
//       backgroundColor: '#ccc',
//       overflow: 'hidden',
//       marginTop: 8,
//       width: '100%',
//     },
//     progressFill: {
//       height: '100%',
//       backgroundColor: '#4caf50',
//       borderRadius: 4,
//     },
//     settingsGroup: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: 12,
//       marginTop: 16,
//       borderColor: theme.colors.surfaceBorder,
//       borderWidth: 1,
//       overflow: 'hidden',
//     },
//     settingsItem: {
//       paddingVertical: 12,
//       paddingHorizontal: 16,
//       backgroundColor: '#1c1c1e',
//       borderBottomWidth: 1,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     firstItem: {
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//     },
//     lastItem: {
//       borderBottomWidth: 0,
//       borderBottomLeftRadius: 12,
//       borderBottomRightRadius: 12,
//     },
//     row: {
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     iconBox: {
//       width: 32,
//       height: 32,
//       borderRadius: 8,
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginRight: 14,
//       backgroundColor: 'rgba(44, 44, 46, 0.9)',
//       borderColor: 'rgba(74, 74, 76, 0.9)',
//       borderWidth: 1,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.2,
//       shadowRadius: 2,
//       elevation: 2,
//     },
//     icon: {
//       fontSize: 17,
//     },
//     label: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//     },
//     spacer: {
//       flex: 1,
//     },
//   });

//   const {
//     styleProfile,
//     isLoading: profileLoading,
//     isError,
//   } = useStyleProfile(auth0Sub || '');

//   const {
//     data: wardrobe = [],
//     isLoading: wardrobeLoading,
//     isError: wardrobeError,
//   } = useQuery<WardrobeItem[]>({
//     queryKey: ['wardrobe', uuid],
//     enabled: !!uuid,
//     queryFn: async () => {
//       const res = await fetch(`${API_BASE_URL}/wardrobe?user_id=${uuid}`);
//       if (!res.ok) throw new Error('Failed to fetch wardrobe');
//       return await res.json();
//     },
//   });

//   if (!auth0Sub || !uuid || profileLoading || wardrobeLoading) {
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color={colors.primary} />
//         <Text style={{color: 'gray', marginTop: 12}}>Loading profile...</Text>
//       </View>
//     );
//   }

//   if (isError || wardrobeError) {
//     return (
//       <View style={styles.loadingContainer}>
//         <Text style={{color: 'red'}}>❌ Error loading style profile.</Text>
//       </View>
//     );
//   }

//   let progress = 0;
//   try {
//     progress = useProfileProgress(styleProfile, wardrobe);
//   } catch (e) {}

//   const profileSections = [
//     ['Preferences', '🧪', 'Style Preferences'],
//     ['Measurements', '📏', 'Measurements'],
//     ['BudgetAndBrands', '💰', 'Budget & Brands'],
//     ['Appearance', '🧍', 'Appearance'],
//     ['Lifestyle', '🌍', 'Lifestyle'],
//     ['BodyTypes', '📐', 'Body Type'],
//     ['Proportions', '📊', 'Body Proportions'],
//     ['FitPreferences', '🧵', 'Fit Preferences'],
//     ['FashionGoals', '🎯', 'Fashion Goals'],
//     ['Climate', '🌤️', 'Climate'],
//     ['HairColor', '🧑‍🦰', 'Hair Color'],
//     ['SkinTone', '🎨', 'Skin Tone'],
//     ['EyeColor', '👁️', 'Eye Color'],
//     ['ShoppingHabits', '🛍️', 'Shopping Habits'],
//     ['PersonalityTraits', '🧠', 'Personality Traits'],
//     ['ColorPreferences', '🌈', 'Color Preferences'],
//     ['Undertone', '🫧', 'Undertone'],
//     ['StyleKeywords', '🪞', 'Style Keywords'],
//   ];

//   return (
//     <View
//       style={[globalStyles.container, {backgroundColor: colors.background}]}>
//       <Text style={[globalStyles.header, {color: theme.colors.foreground}]}>
//         Style Profile
//       </Text>

//       <View style={globalStyles.section}>
//         <View style={globalStyles.backContainer}>
//           <BackHeader title="" onBack={() => navigate('Profile')} />
//           <Text style={globalStyles.backText}>Back</Text>
//         </View>

//         <View style={globalStyles.centeredSection}>
//           <Text style={styles.progressLabel}>
//             Style Profile {progress}% complete
//           </Text>
//           <View style={styles.progressBar}>
//             <View style={[styles.progressFill, {width: `${progress}%`}]} />
//           </View>
//         </View>
//       </View>

//       <ScrollView>
//         <View style={[globalStyles.section, {paddingBottom: 200}]}>
//           <View style={globalStyles.centeredSection}>
//             <View style={styles.settingsGroup}>
//               {profileSections.map(([screen, emoji, label], idx, arr) => {
//                 const isFirst = idx === 0;
//                 const isLast = idx === arr.length - 1;
//                 return (
//                   <AppleTouchFeedback
//                     key={screen}
//                     onPress={() => navigate(screen as string)}
//                     hapticStyle="impactMedium"
//                     style={[
//                       styles.settingsItem,
//                       isFirst && styles.firstItem,
//                       isLast && styles.lastItem,
//                       {backgroundColor: theme.colors.surface},
//                     ]}>
//                     <View style={styles.row}>
//                       <LinearGradient
//                         colors={['#2f2f2f', '#1f1f1f']}
//                         style={styles.iconBox}>
//                         <Text style={styles.icon}>{emoji}</Text>
//                       </LinearGradient>
//                       <Text style={styles.label}>{label}</Text>
//                       <View style={styles.spacer} />
//                       <Icon
//                         name="chevron-right"
//                         size={22}
//                         color={theme.colors.muted}
//                         style={{marginTop: 1}}
//                       />
//                     </View>
//                   </AppleTouchFeedback>
//                 );
//               })}
//             </View>
//           </View>
//         </View>
//       </ScrollView>
//     </View>
//   );
// }
