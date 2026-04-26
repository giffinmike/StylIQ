import React, {useState, useEffect, useRef} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {View, StyleSheet, TouchableOpacity, Text, Animated} from 'react-native';

import HomeScreen from '../screens/HomeScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ExploreScreen from '../screens/ExploreScreen';
import ClosetScreen from '../screens/ClosetScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AddItemScreen from '../screens/AddItemScreen';
import ItemDetailScreen from '../components/ItemDetailScreen/ItemDetailScreen';
import OutfitSuggestionScreen from '../screens/OutfitSuggestionScreen';
import SearchScreen from '../screens/SearchScreen';
import LoginScreen from '../screens/LoginScreen';
import StyleProfileScreen from '../screens/StyleProfileScreen';
import PreferencesScreen from '../screens/PreferencesScreen';
import BudgetAndBrandsScreen from '../screens/BudgetAndBrandsScreen';
import AppearanceScreen from '../screens/AppearanceScreen';
import LifestyleScreen from '../screens/LifestyleScreen';
import ActivitiesScreen from '../screens/ActivitiesScreen';
import BodyTypesScreen from '../screens/BodyTypesScreen';
import ClimateScreen from '../screens/ClimateScreen';
import ColorPreferencesScreen from '../screens/ColorPreferencesScreen';
import EyeColorScreen from '../screens/EyeColorScreen';
import FashionGoalsScreen from '../screens/FashionGoalsScreen';
import FitPreferencesScreen from '../screens/FitPreferencesScreen';
import FabricPreferencesScreen from '../screens/FabricPreferencesScreen';
import ClothingSizesScreen from '../screens/ClothingSizesScreen';
import OccasionsScreen from '../screens/OccasionsScreen';
import HairColorScreen from '../screens/HairColorScreen';
import PersonalityTraitsScreen from '../screens/PersonalityTraitsScreen';
import ProportionsScreen from '../screens/ProportionsScreen';
import ShoppingHabitScreen from '../screens/ShoppingHabitScreen';
import SkinToneScreen from '../screens/SkinToneScreen';
import StyleIconsScreen from '../screens/StyleIconsScreen';
import OutfitBuilderScreen from '../screens/OutfitBuilderScreen';
import OutfitCanvasScreen from '../screens/OutfitCanvasScreen';
import SavedOutfitsScreen from '../screens/SavedOutfitsScreen';
import {useSavedOutfits} from '../hooks/useSavedOutfits';
import TryOnOverlayWrapperScreen from '../screens/TryOnOverlayWrapperScreen';
import CalendarPlannerScreen from '../screens/CalendarPlannerScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import UndertoneScreen from '../screens/UndertoneScreen';
import StyleKeywordsScreen from '../screens/StyleKeywordsScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import PersonalInformationScreen from '../screens/PersonalInformationScreen';
import AiStylistChatScreen from '../screens/AiStyleChatScreen';
import ContactScreen from '../screens/ContactScreen';
import AboutScreen from '../screens/AboutScreen';
import FeedbackScreen from '../screens/FeedBackScreen';
import WebPageScreen from '../screens/WebPageScreen';
import WebBrowserScreen from '../screens/WebBrowserScreen';
import ShoppingDashboardScreen from '../screens/ShoppingDashboardScreen';
import ShoppingBookmarksScreen from '../screens/ShoppingBookmarksScreen';
import ShoppingCollectionsScreen from '../screens/ShoppingCollectionsScreen';
import ShoppingInsightsScreen from '../screens/ShoppingInsightsScreen';
import RecreatedLookScreen from '../screens/RecreatedLookScreen';
import BarcodeScannerScreen from '../screens/BarcodeScannerScreen';
import VideoFeedScreen from '../screens/VideoFeed';
import BlurredCardScreen from '../screens/BlurredCardScreen';
import ImageCarouselScreen from '../screens/ImageCarousel';
import CommunityShowcaseScreen from '../screens/CommunityShowcaseScreen';
import ChatScreen from '../screens/ChatScreen';
import MessagesScreen from '../screens/MessagesScreen';
import UserProfileScreen from '../screens/UserProfileScreen';
import MeasurementAutoScreen from '../screens/MeasurementAutoScreen';
import {MeasurementLiveScreen} from '../screens/MeasurementLiveScreen';
import MeasurementFrontScreen from '../screens/MeasurementFrontScreen';
import MeasurementJointsAutoScreen from '../screens/MeasurementJointAutoScreen';
import MeasurementSideScreen from '../screens/MeasurementSideScreen';
import MeasurementResultsManualScreen from '../screens/MesurementResultsScreen';
import MeshPreviewScreen from '../screens/MeshPreviewScreen';
import EmotionTestScreen from '../screens/EmotionTestScreen';
import SavedMeasurementsScreen from '../screens/SavedMeasurementsScreen';
import MeasurementsScreen from '../screens/MeasurementsScreen';
import GoldDataViewer from '../screens/GoldDataViewer';
import SplashScreen from '../screens/SplashScreen';
import NotesScreen from '../screens/NotesScreen';
import SaveNoteScreen from '../screens/SaveNoteScreen';
import NoteDetailScreen from '../screens/NoteDetailScreen';
import OutfitHistoryScreen from '../screens/OutfitHistoryScreen';
import OutfitsByOccasionScreen from '../screens/OutfitsByOccasionScreen';
import AllBrandsPickerScreen from '../screens/AllBrandsPickerScreen';
import TripsNavigator from '../screens/Trips/TripsNavigator';
import OutfitsScreen from '../screens/Outfits/OutfitsScreen';

import BottomNavigation from '../components/BottomNavigation/BottomNavigation';
import LayoutWrapper from '../components/LayoutWrapper/LayoutWrapper';

import {useAppTheme} from '../context/ThemeContext';
import {WardrobeItem} from '../types/wardrobe';
import {fetchWardrobeItems} from '../hooks/useWardrobeItems';
import SwipeBackHandler from '../components/Gestures/SwipeBackHandler';

import VoiceMicButton from '../components/VoiceMicButton/VoiceMicButton';

import MeasurementResultsScreen from 'screens/MesurementResultsScreen';
import {
  getCredentialsWithBiometrics,
  hasStoredCredentials,
} from '../utils/auth';
import {useSetUUID, useUUID, useUUIDInitialized} from '../context/UUIDContext';
import jwtDecode from 'jwt-decode';
import {API_BASE_URL} from '../config/api';
import {fetchUserData} from '../hooks/useUserData';

type Screen =
  | 'Splash'
  | 'Login'
  | 'Home'
  | 'Profile'
  | 'StyleProfileScreen'
  | 'Explore'
  | 'Wardrobe'
  | 'Settings'
  | 'Preferences'
  | 'BarcodeScannerScreen'
  | 'SavedMeasurements'
  | 'Measurements'
  | 'BudgetAndBrands'
  | 'Appearance'
  | 'Lifestyle'
  | 'ShoppingHabits'
  | 'StyleSummary'
  | 'Activities'
  | 'BodyTypes'
  | 'Climate'
  | 'ColorPreferences'
  | 'EyeColor'
  | 'FashionGoals'
  | 'FitPreferences'
  | 'FabricPreferences'
  | 'ClothingSizes'
  | 'Occasions'
  | 'HairColor'
  | 'PersonalityTraits'
  | 'PreferenceStrength'
  | 'Proportions'
  | 'SearchScreen'
  | 'SkinTone'
  | 'StyleIcon'
  | 'Voice'
  | 'ItemDetail'
  | 'AddItem'
  | 'Outfit'
  | 'Search'
  | 'OutfitBuilder'
  | 'OutfitCanvas'
  | 'SavedOutfits'
  | 'TryOnOverlay'
  | 'Notifications'
  | 'Undertone'
  | 'StyleKeywords'
  | 'Onboarding'
  | 'PersonalInformation'
  | 'ContactScreen'
  | 'AboutScreen'
  | 'FeedbackScreen'
  | 'AiStylistChatScreen'
  | 'RecreatedLook'
  | 'WebPageScreen'
  | 'WebBrowser'
  | 'ShoppingDashboard'
  | 'ShoppingBookmarks'
  | 'ShoppingCollections'
  | 'ShoppingInsights'
  | 'Planner'
  | 'BlurredCardScreen'
  | 'ImageCarouselScreen'
  | 'VideoFeedScreen'
  | 'CommunityShowcaseScreen'
  | 'OnboardingScreen'
  | 'MeasurementLiveScreen'
  | 'MeasurementFrontScreen'
  | 'MeasurementJointsAutoScreen'
  | 'MeasurementSideScreen'
  | 'MeasurementResultsManualScreen'
  | 'MeshPreviewScreen'
  | 'EmotionTestScreen'
  | 'MeasurementAutoScreen'
  | 'GoldDataViewer'
  | 'ChatScreen'
  | 'MessagesScreen'
  | 'UserProfileScreen'
  | 'Notes'
  | 'SaveNote'
  | 'NoteDetail'
  | 'Closet'
  | 'Trips'
  | 'Outfits';

const RootNavigator = ({
  registerNavigate,
  onScreenChange, // ✅ add this
}: {
  registerNavigate?: (fn: any) => void;
  onScreenChange?: (screen: string) => void;
}) => {
  const [currentScreen, setCurrentScreen] = useState<Screen>('Splash');
  const [screenParams, setScreenParams] = useState<any>(null);
  const [wardrobe, setWardrobe] = useState<WardrobeItem[]>([]);

  const screensWithNoHeader = ['Splash', 'Login', 'ItemDetail', 'AddItem', 'VideoFeedScreen', 'ImageCarouselScreen', 'Onboarding'];
  const screensWithSettings = ['Profile'];
  const screensWithoutBottomNav = ['Splash', 'Login', 'VideoFeedScreen', 'ImageCarouselScreen', 'WebBrowser', 'OutfitCanvas'];

  const screenHistory = useRef<Screen[]>([]); // ✅ full navigation history stack
  const isGoingBackRef = useRef(false);

  // Shared scroll position for bottom nav hide/show
  const scrollY = useRef(new Animated.Value(0)).current;

  // Expose scrollY globally so screens can use it
  useEffect(() => {
    global.__navScrollY = scrollY;
    return () => {
      global.__navScrollY = undefined;
    };
  }, [scrollY]);

  const {theme} = useAppTheme();
  const setUUID = useSetUUID();
  const contextUUID = useUUID();
  const isUUIDInitialized = useUUIDInitialized();

  useEffect(() => {
    if (registerNavigate) {
      registerNavigate(navigate);
    }
  }, [registerNavigate]);

  // ✅ ADD THIS useEffect right below
  useEffect(() => {
    onScreenChange?.(currentScreen);
  }, [currentScreen]);

  // Fetch real wardrobe when user is authenticated, clear on logout
  useEffect(() => {
    // console.warn('[WARDROBE] useEffect TRIGGERED - contextUUID:', contextUUID, 'isUUIDInitialized:', isUUIDInitialized);

    // Clear wardrobe when user logs out (UUID becomes null)
    if (!contextUUID) {
      // console.warn('[WARDROBE] 🧹 Clearing wardrobe (user logged out)');
      setWardrobe([]);
      return;
    }

    if (contextUUID && isUUIDInitialized) {
      // console.warn('[WARDROBE] Fetching real wardrobe for user:', contextUUID);
      fetchWardrobeItems(contextUUID)
        .then(items => {
          // console.warn('[WARDROBE] API response:', items?.length, 'items');
          // if (items?.[0]) {
          //   console.warn('[WARDROBE] First item image:', items[0].image);
          // }
          // Always set wardrobe from fetch result (even if empty) to ensure clean state for new users
          setWardrobe(items || []);
          // console.warn(`[WARDROBE] ✅ Loaded ${items?.length || 0} real wardrobe items`);
        })
        .catch(err => console.error('[WARDROBE] ❌ Failed to fetch:', err));
    }
  }, [contextUUID, isUUIDInitialized]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
    },
    screen: {
      flex: 1,
    },
    debugButton: {
      position: 'absolute',
      top: 55,
      right: 145,
      backgroundColor: '#007AFF',
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 8,
      zIndex: 999,
    },
    debugButtonText: {
      color: 'white',
      fontWeight: '700',
    },
  });

  const user = {
    name: 'Mike Giffin',
    avatarUrl: 'https://placekitten.com/300/300',
  };

  const navigate = (screen: Screen, params?: any) => {
    if (isGoingBackRef.current) {
      isGoingBackRef.current = false;
      if (screenHistory.current.length === 0 && (screen === 'ItemDetail' || screen === 'AddItem')) {
        screenHistory.current.push(currentScreen);
      }
    } else if (screen !== currentScreen) {
      screenHistory.current.push(currentScreen);
    } else if (screen === 'ItemDetail' || screen === 'AddItem') {
      screenHistory.current.push(currentScreen);
    }

    setCurrentScreen(screen);
    setScreenParams(params || null);
  };

  const addToWardrobe = (item: any) => {
    const newItem = {
      ...item,
      favorite: false,
    };
    setWardrobe(prev => [newItem, ...prev]);
    setCurrentScreen('Wardrobe');
  };

  const toggleFavorite = (id: string) => {
    setWardrobe(prev =>
      prev.map(item =>
        item.id === id ? {...item, favorite: !item.favorite} : item,
      ),
    );
  };

  const {
    savedOutfits,
    saveOutfit,
    deleteOutfit,
    toggleFavorite: toggleOutfitFavorite,
  } = useSavedOutfits();

  const routeAfterLogin = async () => {
    try {
      const logged = await AsyncStorage.getItem('auth_logged_in');
      if (logged !== 'true') {
        setCurrentScreen('Login');
        return;
      }

      // CRITICAL: Use UUID from context - it's derived from /auth/profile which validates JWT
      // DO NOT use AsyncStorage.getItem('user_id') directly - that's a stale cache
      // The contextUUID is set by UUIDContext after server validates auth0_sub
      const userId = contextUUID;

      // console.log('[routeAfterLogin] Using context UUID:', userId);

      // If UUID not yet initialized by context, wait briefly or use context value
      // This handles the race condition where routeAfterLogin is called before UUIDContext finishes
      if (!userId && !isUUIDInitialized) {
        // console.log('[routeAfterLogin] Waiting for UUIDContext to initialize...');
        // Context will set UUID after /auth/profile returns
        // For now, check if we at least have a cached value as temporary fallback
        const cachedUserId = await AsyncStorage.getItem('user_id');
        if (cachedUserId) {
          // console.log('[routeAfterLogin] Using cached user_id temporarily:', cachedUserId);
          const user = await fetchUserData(cachedUserId);
          if (user) {
            const onboarded = user?.onboarding_complete === true;
            await AsyncStorage.setItem('onboarding_complete', onboarded ? 'true' : 'false');
            if (onboarded) {
              setScreenParams({autoNavigateToHome: true});
              setCurrentScreen('VideoFeedScreen');
            } else {
              setCurrentScreen('Onboarding');
            }
            return;
          }
        }
      }

      // Fetch fresh onboarding status from server (cached via TanStack Query)
      if (userId) {
        const user = await fetchUserData(userId);
        if (user) {
          const onboarded = user?.onboarding_complete === true;
          await AsyncStorage.setItem('onboarding_complete', onboarded ? 'true' : 'false');
          if (onboarded) {
            setScreenParams({autoNavigateToHome: true});
            setCurrentScreen('VideoFeedScreen');
          } else {
            setCurrentScreen('Onboarding');
          }
          return;
        }
      }
      // Fallback to local storage if server fetch fails
      const onboarded = await AsyncStorage.getItem('onboarding_complete');
      if (onboarded === 'true') {
        setScreenParams({autoNavigateToHome: true});
        setCurrentScreen('VideoFeedScreen');
      } else {
        setCurrentScreen('Onboarding');
      }
    } catch {
      setScreenParams({autoNavigateToHome: true});
      setCurrentScreen('VideoFeedScreen');
    }
  };

  const goBack = () => {
    global.goingBack = false;
    isGoingBackRef.current = true;

    setTimeout(() => {
      isGoingBackRef.current = false;
    }, 500);

    const prev = screenHistory.current.pop();

    if (!prev) {
      setCurrentScreen('Home');
      return;
    }

    setScreenParams(null);
    setCurrentScreen(prev);
  };

  // ✅ Register global goBack for gestures
  useEffect(() => {
    global.__rootGoBack = goBack;
    return () => {
      global.__rootGoBack = undefined;
    };
  }, []);

  // ✅ Register auth expired handler for 401 responses
  useEffect(() => {
    global.__onAuthExpired = () => {
      console.log('🔒 Auth expired - navigating to Login');
      setCurrentScreen('Login');
    };
    return () => {
      global.__onAuthExpired = undefined;
    };
  }, []);

  const renderScreen = () => {
    switch (currentScreen) {
      case 'Splash':
        return <SplashScreen onReady={routeAfterLogin} />;

      case 'Login':
        return (
          <LoginScreen
            onLoginSuccess={routeAfterLogin}
            email={''}
            onGoogleLogin={() => {}}
            onPasswordLogin={() => {}}
            onFaceIdLogin={async () => {
              console.log('🔐 Face ID button pressed');
              try {
                // Check if user has previously logged in
                const hasCredentials = await hasStoredCredentials();
                console.log('🔐 Has stored credentials:', hasCredentials);

                if (hasCredentials) {
                  // User has logged in before - use Face ID to unlock stored credentials
                  const credentials = await getCredentialsWithBiometrics();

                  if (credentials) {
                    // Successfully authenticated with Face ID
                    // Decode the idToken to get user info
                    const idToken = credentials.idToken;
                    if (idToken) {
                      const decoded: any = jwtDecode(idToken);
                      const auth0_sub = decoded.sub;

                      // Sync with backend to get user_id
                      const syncRes = await fetch(`${API_BASE_URL}/users/sync`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${credentials.accessToken}`,
                        },
                        body: JSON.stringify({
                          auth0_sub,
                          email: decoded.email,
                          name: decoded.name,
                        }),
                      });
                      const user = await syncRes.json();

                      // Set auth state
                      await AsyncStorage.setItem('auth_logged_in', 'true');
                      if (user?.id) {
                        await AsyncStorage.setItem('user_id', String(user.id));
                        setUUID(String(user.id));
                      }
                    }
                    // Small delay to ensure UUID state propagates through context
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await routeAfterLogin();
                  } else {
                    console.log('Face ID authentication failed or cancelled');
                  }
                } else {
                  // No stored credentials - user needs to log in with Auth0 first
                  // This shouldn't normally happen from Face ID button, but handle it gracefully
                  console.log('No stored credentials - redirecting to normal login');
                }
              } catch (e) {
                console.error('Face ID login error:', e);
              }
            }}
          />
        );

      case 'Profile':
        // Don't cache ProfileScreen - it needs to re-render when user data changes
        return (
          <ProfileScreen
            navigate={navigate}
            user={user}
            wardrobe={wardrobe}
          />
        );

      case 'RecreatedLook':
        console.log('🧩 Rendering RecreatedLookScreen OVER Home');

        const safeNav = {
          navigate,
          goBack: () => {
            console.log('⬅️ [RootNavigator] goBack triggered');
            if (global.showAllSavedLooksModal) {
              console.log('🪄 Triggering global.showAllSavedLooksModal()...');
              global.showAllSavedLooksModal();
            } else if (global.__rootGoBack) {
              global.__rootGoBack();
            } else {
              console.warn('[RootNavigator] No global goBack handler found');
            }
          },
        };

        return (
          <View style={{flex: 1}}>
            <HomeScreen navigate={navigate} />
            <View style={{...StyleSheet.absoluteFill, zIndex: 999}}>
              <RecreatedLookScreen
                route={{params: screenParams}}
                navigation={safeNav} // 👈 pass a safe shim
              />
            </View>
          </View>
        );

      case 'StyleProfileScreen':
        return <StyleProfileScreen navigate={navigate} />;
      case 'BarcodeScannerScreen':
        return <BarcodeScannerScreen navigate={navigate} />;
      case 'Explore':
        return <ExploreScreen navigate={navigate} />;
      case 'Wardrobe':
        return (
          <ClosetScreen
            key={wardrobe.length}
            navigate={navigate}
            wardrobe={screenParams?.updatedWardrobe || wardrobe}
            toggleFavorite={toggleFavorite}
          />
        );

      case 'OutfitBuilder':
        return (
          <OutfitBuilderScreen
            wardrobe={wardrobe}
            navigate={navigate}
            saveOutfit={saveOutfit}
          />
        );
      case 'OutfitCanvas':
        return (
          <OutfitCanvasScreen
            navigate={navigate}
            initialItem={screenParams?.initialItem}
          />
        );
      case 'SavedOutfits':
        return (
          <SavedOutfitsScreen
            savedOutfits={savedOutfits}
            onDelete={deleteOutfit}
            onToggleFavorite={toggleOutfitFavorite}
          />
        );
      case 'Settings':
        // console.log('🔁 Rendering Settings. history:', screenHistory.current);
        return <SettingsScreen navigate={navigate} />;

      case 'Notifications':
        return <NotificationsScreen navigate={navigate} />;
      case 'Notes':
        return <NotesScreen navigate={navigate} />;
      case 'SaveNote':
        return <SaveNoteScreen navigate={navigate} params={screenParams} />;
      case 'NoteDetail':
        return <NoteDetailScreen navigate={navigate} params={screenParams} />;
      case 'Outfits':
        return <OutfitsScreen navigate={navigate} />;
      case 'OutfitHistory':
        return <OutfitHistoryScreen navigate={navigate} />;
      case 'OutfitsByOccasion':
        return <OutfitsByOccasionScreen navigate={navigate} />;
      case 'Preferences':
        return <PreferencesScreen navigate={navigate} />;
      case 'SavedMeasurements':
        return <SavedMeasurementsScreen navigate={navigate} />;
      case 'Measurements':
        return <MeasurementsScreen navigate={navigate} />;

      case 'MeasurementJointsAutoScreen':
        return <MeasurementJointsAutoScreen navigate={navigate} />;

      case 'TryOnOverlay':
        return <TryOnOverlayWrapperScreen screenParams={screenParams} />;
      case 'BudgetAndBrands':
        return <BudgetAndBrandsScreen navigate={navigate} />;
      case 'AllBrandsPicker':
        return <AllBrandsPickerScreen navigate={navigate} goBack={goBack} params={screenParams} />;
      case 'BlurredCardScreen':
        return <BlurredCardScreen navigate={navigate} />;
      case 'Appearance':
        return <AppearanceScreen navigate={navigate} />;
      case 'ContactScreen':
        return <ContactScreen navigate={navigate} />;
      case 'ImageCarouselScreen':
        return <ImageCarouselScreen navigate={navigate} />;
      case 'MeasurementFrontScreen':
        return <MeasurementFrontScreen navigate={navigate} />;
      case 'FeedbackScreen':
        return <FeedbackScreen navigate={navigate} />;
      case 'MeshPreviewScreen':
        return <MeshPreviewScreen navigate={navigate} />;
      case 'EmotionTestScreen':
        return <EmotionTestScreen navigate={navigate} />;
      case 'OnboardingScreen':
        return <OnboardingScreen navigate={navigate} />;
      case 'MeasurementResultsManualScreen':
        return <MeasurementResultsManualScreen navigate={navigate} />;
      case 'AboutScreen':
        return <AboutScreen navigate={navigate} />;
      case 'WebPageScreen':
        return (
          <WebPageScreen route={{params: screenParams}} navigate={navigate} />
        );
      case 'WebBrowser':
        return (
          <WebBrowserScreen
            key="webbrowser-screen"
            route={{params: screenParams}}
            navigate={navigate}
          />
        );
      case 'ShoppingDashboard':
        return <ShoppingDashboardScreen navigate={navigate} />;
      case 'ShoppingBookmarks':
        return <ShoppingBookmarksScreen navigate={navigate} />;
      case 'ShoppingCollections':
        return (
          <ShoppingCollectionsScreen
            route={{params: screenParams}}
            navigate={navigate}
          />
        );
      case 'ShoppingInsights':
        return <ShoppingInsightsScreen navigate={navigate} />;
      case 'MeasurementAutoScreen':
        return <MeasurementAutoScreen navigate={navigate} />;
      case 'GoldDataViewer':
        return <GoldDataViewer navigate={navigate} />;
      case 'MeasurementSideScreen':
        return <MeasurementSideScreen navigate={navigate} />;
      case 'Lifestyle':
        return <LifestyleScreen navigate={navigate} />;
      case 'ShoppingHabits':
        return <ShoppingHabitScreen navigate={navigate} />;
      case 'AiStylistChatScreen':
        return <AiStylistChatScreen navigate={navigate} />;
      case 'Activities':
        return <ActivitiesScreen navigate={navigate} />;
      case 'BodyTypes':
        return <BodyTypesScreen navigate={navigate} />;
      case 'MeasurementLiveScreen':
        return <MeasurementLiveScreen navigate={navigate} />;
      case 'Climate':
        return <ClimateScreen navigate={navigate} />;
      case 'ColorPreferences':
        return <ColorPreferencesScreen navigate={navigate} />;
      case 'EyeColor':
        return <EyeColorScreen navigate={navigate} />;
      case 'FashionGoals':
        return <FashionGoalsScreen navigate={navigate} />;
      case 'FitPreferences':
        return <FitPreferencesScreen navigate={navigate} />;
      case 'FabricPreferences':
        return <FabricPreferencesScreen navigate={navigate} />;
      case 'ClothingSizes':
        return <ClothingSizesScreen navigate={navigate} />;
      case 'Occasions':
        return <OccasionsScreen navigate={navigate} />;
      case 'HairColor':
        return <HairColorScreen navigate={navigate} />;
      case 'PersonalityTraits':
        return <PersonalityTraitsScreen navigate={navigate} />;
      case 'Proportions':
        return <ProportionsScreen navigate={navigate} />;
      case 'SkinTone':
        return <SkinToneScreen navigate={navigate} />;
      case 'StyleIcon':
        return <StyleIconsScreen navigate={navigate} />;
      case 'Planner':
        return <CalendarPlannerScreen />;
      case 'Undertone':
        return <UndertoneScreen navigate={navigate} />;
      case 'StyleKeywords':
        return <StyleKeywordsScreen navigate={navigate} />;
      case 'Onboarding':
        return <OnboardingScreen navigate={navigate} />;
      case 'VideoFeedScreen':
        return <VideoFeedScreen navigate={navigate} autoNavigateToHome={screenParams?.autoNavigateToHome} />;
      case 'CommunityShowcaseScreen':
        return <CommunityShowcaseScreen navigate={navigate} initialPostId={screenParams?.initialPostId} />;
      case 'ChatScreen':
        return <ChatScreen navigate={navigate} route={screenParams} />;
      case 'MessagesScreen':
        return <MessagesScreen navigate={navigate as any} />;
      case 'UserProfileScreen':
        return <UserProfileScreen navigate={navigate as any} route={screenParams} goBack={goBack} />;
      case 'PersonalInformation':
        return <PersonalInformationScreen navigate={navigate} />;
      case 'ItemDetail':
        return (
          <ItemDetailScreen
            route={{params: screenParams}}
            navigation={{goBack, navigate}}
          />
        );
      case 'AddItem':
        return <AddItemScreen navigate={navigate} goBack={goBack} addItem={addToWardrobe} initialImageUrl={screenParams?.imageUrl} />;
      case 'Outfit':
        return <OutfitSuggestionScreen navigate={navigate} />;
      case 'Search':
        return (
          <SearchScreen
            wardrobe={wardrobe}
            navigate={navigate}
            goBack={goBack}
          />
        );
      case 'Trips':
        return <TripsNavigator navigate={navigate} wardrobe={wardrobe} />;
      default:
        return (
          <HomeScreen
            key={screenParams?.__forceRemount}
            navigate={navigate}
            wardrobe={wardrobe}
          />
        );
    }
  };

  return (
    <View
      style={[styles.container, {backgroundColor: theme.colors.background}]}>
      <LayoutWrapper
        navigate={navigate}
        hideHeader={screensWithNoHeader.includes(currentScreen)}
        showSettings={screensWithSettings.includes(currentScreen)}
        currentScreen={currentScreen}>
        <SwipeBackHandler
          onSwipeBack={goBack}
          enabled={true}>
          <View style={[styles.screen, {backgroundColor: theme.colors.background}]}>
            {renderScreen()}
          </View>
        </SwipeBackHandler>
      </LayoutWrapper>

      {/* ✅ Always visible when logged in */}
      {currentScreen !== 'Login' && currentScreen !== 'Onboarding' && !screensWithoutBottomNav.includes(currentScreen) && (
        <>
          <BottomNavigation current={currentScreen} navigate={navigate} scrollY={scrollY} />
          {/* <VoiceMicButton navigate={navigate} /> */}
        </>
      )}
    </View>
  );
};

export default RootNavigator;

////////////////////////

// import React, {useState, useEffect, useRef} from 'react';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {View, StyleSheet, TouchableOpacity, Text} from 'react-native';

// import HomeScreen from '../screens/HomeScreen';
// import ProfileScreen from '../screens/ProfileScreen';
// import ExploreScreen from '../screens/ExploreScreen';
// import ClosetScreen from '../screens/ClosetScreen';
// import SettingsScreen from '../screens/SettingsScreen';
// import AddItemScreen from '../screens/AddItemScreen';
// import ItemDetailScreen from '../components/ItemDetailScreen/ItemDetailScreen';
// import OutfitSuggestionScreen from '../screens/OutfitSuggestionScreen';
// import SearchScreen from '../screens/SearchScreen';
// import LoginScreen from '../screens/LoginScreen';
// import StyleProfileScreen from '../screens/StyleProfileScreen';
// import PreferencesScreen from '../screens/PreferencesScreen';
// import MeasurementsScreen from '../screens/MeasurementsScreen';
// import BudgetAndBrandsScreen from '../screens/BudgetAndBrandsScreen';
// import AppearanceScreen from '../screens/AppearanceScreen';
// import LifestyleScreen from '../screens/LifestyleScreen';
// import ActivitiesScreen from '../screens/ActivitiesScreen';
// import BodyTypesScreen from '../screens/BodyTypesScreen';
// import ClimateScreen from '../screens/ClimateScreen';
// import ColorPreferencesScreen from '../screens/ColorPreferencesScreen';
// import EyeColorScreen from '../screens/EyeColorScreen';
// import FashionGoalsScreen from '../screens/FashionGoalsScreen';
// import FitPreferencesScreen from '../screens/FitPreferencesScreen';
// import HairColorScreen from '../screens/HairColorScreen';
// import PersonalityTraitsScreen from '../screens/PersonalityTraitsScreen';
// import ProportionsScreen from '../screens/ProportionsScreen';
// import ShoppingHabitScreen from '../screens/ShoppingHabitScreen';
// import SkinToneScreen from '../screens/SkinToneScreen';
// import StyleIconsScreen from '../screens/StyleIconsScreen';
// import OutfitBuilderScreen from '../screens/OutfitBuilderScreen';
// import SavedOutfitsScreen from '../screens/SavedOutfitsScreen';
// import {useSavedOutfits} from '../hooks/useSavedOutfits';
// import TryOnOverlayWrapperScreen from '../screens/TryOnOverlayWrapperScreen';
// import CalendarPlannerScreen from '../screens/CalendarPlannerScreen';
// import NotificationsScreen from '../screens/NotificationsScreen';
// import UndertoneScreen from '../screens/UndertoneScreen';
// import StyleKeywordsScreen from '../screens/StyleKeywordsScreen';
// import OnboardingScreen from '../screens/OnboardingScreen';
// import PersonalInformationScreen from '../screens/PersonalInformationScreen';
// import AiStylistChatScreen from '../screens/AiStyleChatScreen';
// import ContactScreen from '../screens/ContactScreen';
// import AboutScreen from '../screens/AboutScreen';
// import FeedbackScreen from '../screens/FeedBackScreen';
// import WebPageScreen from '../screens/WebPageScreen';
// import RecreatedLookScreen from '../screens/RecreatedLookScreen';
// import BarcodeScannerScreen from '../screens/BarcodeScannerScreen';
// import VideoFeedScreen from '../screens/VideoFeed';
// import BlurredCardScreen from '../screens/BlurredCardScreen';

// import BottomNavigation from '../components/BottomNavigation/BottomNavigation';
// import LayoutWrapper from '../components/LayoutWrapper/LayoutWrapper';

// import {useAppTheme} from '../context/ThemeContext';
// import {mockClothingItems} from '../components/mockClothingItems/mockClothingItems';
// import {WardrobeItem} from '../hooks/useOutfitSuggestion';
// import GlobalGestureHandler from '../components/Gestures/GlobalGestureHandler';

// import VoiceMicButton from '../components/VoiceMicButton/VoiceMicButton';

// import ReactNativeBiometrics from 'react-native-biometrics';
// import {useAuth0} from 'react-native-auth0';

// type Screen =
//   | 'Login'
//   | 'Home'
//   | 'Profile'
//   | 'StyleProfileScreen'
//   | 'Explore'
//   | 'Wardrobe'
//   | 'Settings'
//   | 'Preferences'
//   | 'BarcodeScannerScreen'
//   | 'Measurements'
//   | 'BudgetAndBrands'
//   | 'Appearance'
//   | 'Lifestyle'
//   | 'ShoppingHabits'
//   | 'StyleSummary'
//   | 'Activities'
//   | 'BodyTypes'
//   | 'Climate'
//   | 'ColorPreferences'
//   | 'EyeColor'
//   | 'FashionGoals'
//   | 'FitPreferences'
//   | 'HairColor'
//   | 'PersonalityTraits'
//   | 'PreferenceStrength'
//   | 'Proportions'
//   | 'SearchScreen'
//   | 'SkinTone'
//   | 'StyleIcon'
//   | 'Voice'
//   | 'ItemDetail'
//   | 'AddItem'
//   | 'Outfit'
//   | 'Search'
//   | 'OutfitBuilder'
//   | 'SavedOutfits'
//   | 'TryOnOverlay'
//   | 'Notifications'
//   | 'Undertone'
//   | 'StyleKeywords'
//   | 'Onboarding'
//   | 'PersonalInformation'
//   | 'ContactScreen'
//   | 'AboutScreen'
//   | 'FeedbackScreen'
//   | 'AiStylistChatScreen'
//   | 'RecreatedLook'
//   | 'WebPageScreen'
//   | 'Planner'
//   | 'BlurredCardScreen'
//   | 'VideoFeedScreen';

// const RootNavigator = ({
//   registerNavigate,
// }: {
//   registerNavigate?: (fn: any) => void;
// }) => {
//   const [currentScreen, setCurrentScreen] = useState<Screen>('Login');
//   const [screenParams, setScreenParams] = useState<any>(null);
//   const [wardrobe, setWardrobe] = useState<WardrobeItem[]>(mockClothingItems);

//   const screensWithNoHeader = ['Login', 'ItemDetail', 'AddItem', 'Home'];
//   const screensWithSettings = ['Profile'];

//   const screenHistory = useRef<Screen[]>([]); // ✅ full navigation history stack
//   const isGoingBackRef = useRef(false);

//   const profileScreenCache = useRef<JSX.Element | null>(null);

//   const {theme} = useAppTheme();
//   const {authorize} = useAuth0();
//   const rnBiometrics = new ReactNativeBiometrics();

//   useEffect(() => {
//     if (registerNavigate) {
//       registerNavigate(navigate);
//     }
//   }, [registerNavigate]);

//   const styles = StyleSheet.create({
//     container: {
//       flex: 1,
//     },
//     screen: {
//       flex: 1,
//     },
//     debugButton: {
//       position: 'absolute',
//       top: 55,
//       right: 145,
//       backgroundColor: '#007AFF',
//       paddingVertical: 4,
//       paddingHorizontal: 10,
//       borderRadius: 8,
//       zIndex: 999,
//     },
//     debugButtonText: {
//       color: 'white',
//       fontWeight: '700',
//     },
//   });

//   const user = {
//     name: 'Mike Giffin',
//     avatarUrl: 'https://placekitten.com/300/300',
//   };

//   const navigate = (screen: Screen, params?: any) => {
//     if (isGoingBackRef.current) {
//       console.log('⏩ Skipping push because we just went back');
//       isGoingBackRef.current = false;
//     } else if (screen !== currentScreen) {
//       console.log('📍 Pushing current to history:', currentScreen);
//       screenHistory.current.push(currentScreen);
//     } else {
//       console.log('⚠️ Skipped push because screen is same:', screen);
//     }

//     setCurrentScreen(screen);
//     setScreenParams(params || null);
//   };

//   const addToWardrobe = (item: any) => {
//     const newItem = {
//       ...item,
//       favorite: false,
//     };
//     setWardrobe(prev => [newItem, ...prev]);
//     setCurrentScreen('Wardrobe');
//   };

//   const toggleFavorite = (id: string) => {
//     setWardrobe(prev =>
//       prev.map(item =>
//         item.id === id ? {...item, favorite: !item.favorite} : item,
//       ),
//     );
//   };

//   const {
//     savedOutfits,
//     saveOutfit,
//     deleteOutfit,
//     toggleFavorite: toggleOutfitFavorite,
//   } = useSavedOutfits();

//   const routeAfterLogin = async () => {
//     try {
//       const [[, logged], [, onboarded]] = await AsyncStorage.multiGet([
//         'auth_logged_in',
//         'onboarding_complete',
//       ]);
//       if (logged === 'true') {
//         setCurrentScreen(onboarded === 'true' ? 'Home' : 'Onboarding');
//       } else {
//         setCurrentScreen('Login');
//       }
//     } catch {
//       setCurrentScreen('Home');
//     }
//   };

//   const goBack = () => {
//     console.log('⬅️ goBack called, history:', screenHistory.current);

//     global.goingBack = false;
//     isGoingBackRef.current = true;

//     const prev = screenHistory.current.pop();
//     if (!prev) {
//       console.warn('⚠️ History empty, defaulting to Home');
//       setCurrentScreen('Home');
//       return;
//     }

//     console.log('🔙 Navigating back to:', prev);
//     setScreenParams({__forceRemount: Date.now()});
//     setCurrentScreen(prev);
//   };

//   // ✅ Register global goBack for gestures
//   useEffect(() => {
//     global.__rootGoBack = goBack;
//     console.log('🌍 Global goBack registered');
//     return () => {
//       global.__rootGoBack = undefined;
//     };
//   }, []);

//   useEffect(() => {
//     routeAfterLogin();
//   }, []);

//   const renderScreen = () => {
//     switch (currentScreen) {
//       case 'Login':
//         return (
//           <LoginScreen
//             onLoginSuccess={routeAfterLogin}
//             email={''}
//             onGoogleLogin={() => {}}
//             onPasswordLogin={() => {}}
//             onFaceIdLogin={async () => {
//               try {
//                 const result = await rnBiometrics.simplePrompt({
//                   promptMessage: 'Log in with Face ID',
//                 });

//                 if (result.success) {
//                   const redirectUrl =
//                     'com.stylhelpr.stylhelpr.auth0://dev-xeaol4s5b2zd7wuz.us.auth0.com/ios/com.stylhelpr.stylhelpr/callback';

//                   await authorize({redirectUrl});
//                   await routeAfterLogin();
//                 } else {
//                   console.log('Face ID cancelled');
//                 }
//               } catch (e) {
//                 console.error('Face ID login error:', e);
//               }
//             }}
//           />
//         );

//       case 'Profile':
//         if (!profileScreenCache.current) {
//           profileScreenCache.current = (
//             <ProfileScreen
//               navigate={navigate}
//               user={user}
//               wardrobe={wardrobe}
//             />
//           );
//         }
//         return profileScreenCache.current;

//       case 'RecreatedLook':
//         console.log('🧩 Rendering RecreatedLookScreen OVER Home');

//         const safeNav = {
//           navigate,
//           goBack: () => {
//             console.log('⬅️ [RootNavigator] goBack triggered');
//             if (global.showAllSavedLooksModal) {
//               console.log('🪄 Triggering global.showAllSavedLooksModal()...');
//               global.showAllSavedLooksModal();
//             } else if (global.__rootGoBack) {
//               global.__rootGoBack();
//             } else {
//               console.warn('[RootNavigator] No global goBack handler found');
//             }
//           },
//         };

//         return (
//           <View style={{flex: 1}}>
//             <HomeScreen navigate={navigate} />
//             <View style={{...StyleSheet.absoluteFillObject, zIndex: 999}}>
//               <RecreatedLookScreen
//                 route={{params: screenParams}}
//                 navigation={safeNav} // 👈 pass a safe shim
//               />
//             </View>
//           </View>
//         );

//       case 'StyleProfileScreen':
//         return <StyleProfileScreen navigate={navigate} />;
//       case 'BarcodeScannerScreen':
//         return <BarcodeScannerScreen navigate={navigate} />;
//       case 'Explore':
//         return <ExploreScreen navigate={navigate} />;
//       case 'Wardrobe':
//         return (
//           <ClosetScreen
//             key={wardrobe.length}
//             navigate={navigate}
//             wardrobe={screenParams?.updatedWardrobe || wardrobe}
//             toggleFavorite={toggleFavorite}
//           />
//         );

//       case 'OutfitBuilder':
//         return (
//           <OutfitBuilderScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             saveOutfit={saveOutfit}
//           />
//         );
//       case 'SavedOutfits':
//         return (
//           <SavedOutfitsScreen
//             savedOutfits={savedOutfits}
//             onDelete={deleteOutfit}
//             onToggleFavorite={toggleOutfitFavorite}
//           />
//         );
//       case 'Settings':
//         console.log('🔁 Rendering Settings. history:', screenHistory.current);
//         return <SettingsScreen navigate={navigate} />;

//       case 'Notifications':
//         return <NotificationsScreen navigate={navigate} />;
//       case 'Preferences':
//         return <PreferencesScreen navigate={navigate} />;
//       case 'Measurements':
//         return <MeasurementsScreen navigate={navigate} />;
//       case 'TryOnOverlay':
//         return <TryOnOverlayWrapperScreen screenParams={screenParams} />;
//       case 'BudgetAndBrands':
//         return <BudgetAndBrandsScreen navigate={navigate} />;
//       case 'BlurredCardScreen':
//         return <BlurredCardScreen navigate={navigate} />;
//       case 'Appearance':
//         return <AppearanceScreen navigate={navigate} />;
//       case 'ContactScreen':
//         return <ContactScreen navigate={navigate} />;
//       case 'FeedbackScreen':
//         return <FeedbackScreen navigate={navigate} />;
//       case 'AboutScreen':
//         return <AboutScreen navigate={navigate} />;
//       case 'WebPageScreen':
//         return (
//           <WebPageScreen route={{params: screenParams}} navigate={navigate} />
//         );
//       case 'Lifestyle':
//         return <LifestyleScreen navigate={navigate} />;
//       case 'ShoppingHabits':
//         return <ShoppingHabitScreen navigate={navigate} />;
//       case 'AiStylistChatScreen':
//         return <AiStylistChatScreen navigate={navigate} />;
//       case 'Activities':
//         return <ActivitiesScreen navigate={navigate} />;
//       case 'BodyTypes':
//         return <BodyTypesScreen navigate={navigate} />;
//       case 'Climate':
//         return <ClimateScreen navigate={navigate} />;
//       case 'ColorPreferences':
//         return <ColorPreferencesScreen navigate={navigate} />;
//       case 'EyeColor':
//         return <EyeColorScreen navigate={navigate} />;
//       case 'FashionGoals':
//         return <FashionGoalsScreen navigate={navigate} />;
//       case 'FitPreferences':
//         return <FitPreferencesScreen navigate={navigate} />;
//       case 'HairColor':
//         return <HairColorScreen navigate={navigate} />;
//       case 'PersonalityTraits':
//         return <PersonalityTraitsScreen navigate={navigate} />;
//       case 'Proportions':
//         return <ProportionsScreen navigate={navigate} />;
//       case 'SkinTone':
//         return <SkinToneScreen navigate={navigate} />;
//       case 'StyleIcon':
//         return <StyleIconsScreen navigate={navigate} />;
//       case 'Planner':
//         return <CalendarPlannerScreen />;
//       case 'Undertone':
//         return <UndertoneScreen navigate={navigate} />;
//       case 'StyleKeywords':
//         return <StyleKeywordsScreen navigate={navigate} />;
//       case 'Onboarding':
//         return <OnboardingScreen navigate={navigate} />;
//       case 'VideoFeedScreen':
//         return <VideoFeedScreen navigate={navigate} />;
//       case 'PersonalInformation':
//         return <PersonalInformationScreen navigate={navigate} />;
//       case 'ItemDetail':
//         return (
//           <ItemDetailScreen
//             route={{params: screenParams}}
//             navigation={{goBack}}
//           />
//         );
//       case 'AddItem':
//         return <AddItemScreen navigate={navigate} addItem={addToWardrobe} />;
//       case 'Outfit':
//         return <OutfitSuggestionScreen navigate={navigate} />;
//       case 'Search':
//         return (
//           <SearchScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             goBack={goBack}
//           />
//         );
//       default:
//         return (
//           <HomeScreen
//             key={screenParams?.__forceRemount}
//             navigate={navigate}
//             wardrobe={wardrobe}
//           />
//         );
//     }
//   };

//   return (
//     <View
//       style={[styles.container, {backgroundColor: theme.colors.background}]}>
//       <LayoutWrapper
//         navigate={navigate}
//         hideHeader={screensWithNoHeader.includes(currentScreen)}
//         showSettings={screensWithSettings.includes(currentScreen)}>
//         <GlobalGestureHandler onEdgeSwipeBack={goBack}>
//           <View style={styles.screen}>{renderScreen()}</View>
//         </GlobalGestureHandler>
//       </LayoutWrapper>

//       {/* ✅ Always visible when logged in */}
//       {currentScreen !== 'Login' && currentScreen !== 'Onboarding' && (
//         <>
//           <BottomNavigation current={currentScreen} navigate={navigate} />
//           {/* <VoiceMicButton navigate={navigate} /> */}
//         </>
//       )}
//     </View>
//   );
// };

// export default RootNavigator;

////////////////////

// import React, {useState, useEffect, useRef} from 'react';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {View, StyleSheet, TouchableOpacity, Text} from 'react-native';

// import HomeScreen from '../screens/HomeScreen';
// import ProfileScreen from '../screens/ProfileScreen';
// import ExploreScreen from '../screens/ExploreScreen';
// import ClosetScreen from '../screens/ClosetScreen';
// import SettingsScreen from '../screens/SettingsScreen';
// import AddItemScreen from '../screens/AddItemScreen';
// import ItemDetailScreen from '../components/ItemDetailScreen/ItemDetailScreen';
// import OutfitSuggestionScreen from '../screens/OutfitSuggestionScreen';
// import SearchScreen from '../screens/SearchScreen';
// import LoginScreen from '../screens/LoginScreen';
// import StyleProfileScreen from '../screens/StyleProfileScreen';
// import PreferencesScreen from '../screens/PreferencesScreen';
// import MeasurementsScreen from '../screens/MeasurementsScreen';
// import BudgetAndBrandsScreen from '../screens/BudgetAndBrandsScreen';
// import AppearanceScreen from '../screens/AppearanceScreen';
// import LifestyleScreen from '../screens/LifestyleScreen';
// import ActivitiesScreen from '../screens/ActivitiesScreen';
// import BodyTypesScreen from '../screens/BodyTypesScreen';
// import ClimateScreen from '../screens/ClimateScreen';
// import ColorPreferencesScreen from '../screens/ColorPreferencesScreen';
// import EyeColorScreen from '../screens/EyeColorScreen';
// import FashionGoalsScreen from '../screens/FashionGoalsScreen';
// import FitPreferencesScreen from '../screens/FitPreferencesScreen';
// import HairColorScreen from '../screens/HairColorScreen';
// import PersonalityTraitsScreen from '../screens/PersonalityTraitsScreen';
// import ProportionsScreen from '../screens/ProportionsScreen';
// import ShoppingHabitScreen from '../screens/ShoppingHabitScreen';
// import SkinToneScreen from '../screens/SkinToneScreen';
// import StyleIconsScreen from '../screens/StyleIconsScreen';
// import OutfitBuilderScreen from '../screens/OutfitBuilderScreen';
// import SavedOutfitsScreen from '../screens/SavedOutfitsScreen';
// import {useSavedOutfits} from '../hooks/useSavedOutfits';
// import TryOnOverlayWrapperScreen from '../screens/TryOnOverlayWrapperScreen';
// import CalendarPlannerScreen from '../screens/CalendarPlannerScreen';
// import NotificationsScreen from '../screens/NotificationsScreen';
// import UndertoneScreen from '../screens/UndertoneScreen';
// import StyleKeywordsScreen from '../screens/StyleKeywordsScreen';
// import OnboardingScreen from '../screens/OnboardingScreen';
// import PersonalInformationScreen from '../screens/PersonalInformationScreen';
// import AiStylistChatScreen from '../screens/AiStyleChatScreen';
// import ContactScreen from '../screens/ContactScreen';
// import AboutScreen from '../screens/AboutScreen';
// import FeedbackScreen from '../screens/FeedBackScreen';
// import WebPageScreen from '../screens/WebPageScreen';
// import RecreatedLookScreen from '../screens/RecreatedLookScreen';
// import BarcodeScannerScreen from '../screens/BarcodeScannerScreen';

// import BottomNavigation from '../components/BottomNavigation/BottomNavigation';
// import LayoutWrapper from '../components/LayoutWrapper/LayoutWrapper';

// import {useAppTheme} from '../context/ThemeContext';
// import {mockClothingItems} from '../components/mockClothingItems/mockClothingItems';
// import {WardrobeItem} from '../hooks/useOutfitSuggestion';
// import GlobalGestureHandler from '../components/Gestures/GlobalGestureHandler';

// import VoiceMicButton from '../components/VoiceMicButton/VoiceMicButton';

// import ReactNativeBiometrics from 'react-native-biometrics';
// import {useAuth0} from 'react-native-auth0';

// type Screen =
//   | 'Login'
//   | 'Home'
//   | 'Profile'
//   | 'StyleProfileScreen'
//   | 'Explore'
//   | 'Wardrobe'
//   | 'Settings'
//   | 'Preferences'
//   | 'BarcodeScannerScreen'
//   | 'Measurements'
//   | 'BudgetAndBrands'
//   | 'Appearance'
//   | 'Lifestyle'
//   | 'ShoppingHabits'
//   | 'StyleSummary'
//   | 'Activities'
//   | 'BodyTypes'
//   | 'Climate'
//   | 'ColorPreferences'
//   | 'EyeColor'
//   | 'FashionGoals'
//   | 'FitPreferences'
//   | 'HairColor'
//   | 'PersonalityTraits'
//   | 'PreferenceStrength'
//   | 'Proportions'
//   | 'SearchScreen'
//   | 'SkinTone'
//   | 'StyleIcon'
//   | 'Voice'
//   | 'ItemDetail'
//   | 'AddItem'
//   | 'Outfit'
//   | 'Search'
//   | 'OutfitBuilder'
//   | 'SavedOutfits'
//   | 'TryOnOverlay'
//   | 'Notifications'
//   | 'Undertone'
//   | 'StyleKeywords'
//   | 'Onboarding'
//   | 'PersonalInformation'
//   | 'ContactScreen'
//   | 'AboutScreen'
//   | 'FeedbackScreen'
//   | 'AiStylistChatScreen'
//   | 'RecreatedLook'
//   | 'WebPageScreen'
//   | 'Planner';

// const RootNavigator = ({
//   registerNavigate,
// }: {
//   registerNavigate?: (fn: any) => void;
// }) => {
//   const [currentScreen, setCurrentScreen] = useState<Screen>('Login');
//   const [screenParams, setScreenParams] = useState<any>(null);
//   const [wardrobe, setWardrobe] = useState<WardrobeItem[]>(mockClothingItems);

//   const screensWithNoHeader = ['Login', 'ItemDetail', 'AddItem', 'Home'];
//   const screensWithSettings = ['Profile'];

//   const screenHistory = useRef<Screen[]>([]); // ✅ full navigation history stack
//   const isGoingBackRef = useRef(false);

//   const profileScreenCache = useRef<JSX.Element | null>(null);

//   const {theme} = useAppTheme();
//   const {authorize} = useAuth0();
//   const rnBiometrics = new ReactNativeBiometrics();

//   useEffect(() => {
//     if (registerNavigate) {
//       registerNavigate(navigate);
//     }
//   }, [registerNavigate]);

//   const styles = StyleSheet.create({
//     container: {
//       flex: 1,
//     },
//     screen: {
//       flex: 1,
//     },
//     debugButton: {
//       position: 'absolute',
//       top: 55,
//       right: 145,
//       backgroundColor: '#007AFF',
//       paddingVertical: 4,
//       paddingHorizontal: 10,
//       borderRadius: 8,
//       zIndex: 999,
//     },
//     debugButtonText: {
//       color: 'white',
//       fontWeight: '700',
//     },
//   });

//   const user = {
//     name: 'Mike Giffin',
//     avatarUrl: 'https://placekitten.com/300/300',
//   };

//   const navigate = (screen: Screen, params?: any) => {
//     if (isGoingBackRef.current) {
//       console.log('⏩ Skipping push because we just went back');
//       isGoingBackRef.current = false;
//     } else if (screen !== currentScreen) {
//       console.log('📍 Pushing current to history:', currentScreen);
//       screenHistory.current.push(currentScreen);
//     } else {
//       console.log('⚠️ Skipped push because screen is same:', screen);
//     }

//     setCurrentScreen(screen);
//     setScreenParams(params || null);
//   };

//   const addToWardrobe = (item: any) => {
//     const newItem = {
//       ...item,
//       favorite: false,
//     };
//     setWardrobe(prev => [newItem, ...prev]);
//     setCurrentScreen('Wardrobe');
//   };

//   const toggleFavorite = (id: string) => {
//     setWardrobe(prev =>
//       prev.map(item =>
//         item.id === id ? {...item, favorite: !item.favorite} : item,
//       ),
//     );
//   };

//   const {
//     savedOutfits,
//     saveOutfit,
//     deleteOutfit,
//     toggleFavorite: toggleOutfitFavorite,
//   } = useSavedOutfits();

//   const routeAfterLogin = async () => {
//     try {
//       const [[, logged], [, onboarded]] = await AsyncStorage.multiGet([
//         'auth_logged_in',
//         'onboarding_complete',
//       ]);
//       if (logged === 'true') {
//         setCurrentScreen(onboarded === 'true' ? 'Home' : 'Onboarding');
//       } else {
//         setCurrentScreen('Login');
//       }
//     } catch {
//       setCurrentScreen('Home');
//     }
//   };

//   const goBack = () => {
//     console.log('⬅️ goBack called, history:', screenHistory.current);

//     global.goingBack = false;
//     isGoingBackRef.current = true;

//     const prev = screenHistory.current.pop();
//     if (!prev) {
//       console.warn('⚠️ History empty, defaulting to Home');
//       setCurrentScreen('Home');
//       return;
//     }

//     console.log('🔙 Navigating back to:', prev);
//     setScreenParams({__forceRemount: Date.now()});
//     setCurrentScreen(prev);
//   };

//   // ✅ Register global goBack for gestures
//   useEffect(() => {
//     global.__rootGoBack = goBack;
//     console.log('🌍 Global goBack registered');
//     return () => {
//       global.__rootGoBack = undefined;
//     };
//   }, []);

//   useEffect(() => {
//     routeAfterLogin();
//   }, []);

//   const renderScreen = () => {
//     switch (currentScreen) {
//       case 'Login':
//         return (
//           <LoginScreen
//             onLoginSuccess={routeAfterLogin}
//             email={''}
//             onGoogleLogin={() => {}}
//             onPasswordLogin={() => {}}
//             onFaceIdLogin={async () => {
//               try {
//                 const result = await rnBiometrics.simplePrompt({
//                   promptMessage: 'Log in with Face ID',
//                 });

//                 if (result.success) {
//                   const redirectUrl =
//                     'com.stylhelpr.stylhelpr.auth0://dev-xeaol4s5b2zd7wuz.us.auth0.com/ios/com.stylhelpr.stylhelpr/callback';

//                   await authorize({redirectUrl});
//                   await routeAfterLogin();
//                 } else {
//                   console.log('Face ID cancelled');
//                 }
//               } catch (e) {
//                 console.error('Face ID login error:', e);
//               }
//             }}
//           />
//         );

//       case 'Profile':
//         if (!profileScreenCache.current) {
//           profileScreenCache.current = (
//             <ProfileScreen
//               navigate={navigate}
//               user={user}
//               wardrobe={wardrobe}
//             />
//           );
//         }
//         return profileScreenCache.current;

//       case 'RecreatedLook':
//         console.log('🧩 Rendering RecreatedLookScreen OVER Home');

//         const safeNav = {
//           navigate,
//           goBack: () => {
//             console.log('⬅️ [RootNavigator] goBack triggered');
//             if (global.showAllSavedLooksModal) {
//               console.log('🪄 Triggering global.showAllSavedLooksModal()...');
//               global.showAllSavedLooksModal();
//             } else if (global.__rootGoBack) {
//               global.__rootGoBack();
//             } else {
//               console.warn('[RootNavigator] No global goBack handler found');
//             }
//           },
//         };

//         return (
//           <View style={{flex: 1}}>
//             <HomeScreen navigate={navigate} />
//             <View style={{...StyleSheet.absoluteFillObject, zIndex: 999}}>
//               <RecreatedLookScreen
//                 route={{params: screenParams}}
//                 navigation={safeNav} // 👈 pass a safe shim
//               />
//             </View>
//           </View>
//         );

//       case 'StyleProfileScreen':
//         return <StyleProfileScreen navigate={navigate} />;
//       case 'BarcodeScannerScreen':
//         return <BarcodeScannerScreen navigate={navigate} />;
//       case 'Explore':
//         return <ExploreScreen navigate={navigate} />;
//       case 'Wardrobe':
//         return (
//           <ClosetScreen
//             key={wardrobe.length}
//             navigate={navigate}
//             wardrobe={screenParams?.updatedWardrobe || wardrobe}
//             toggleFavorite={toggleFavorite}
//           />
//         );

//       case 'OutfitBuilder':
//         return (
//           <OutfitBuilderScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             saveOutfit={saveOutfit}
//           />
//         );
//       case 'SavedOutfits':
//         return (
//           <SavedOutfitsScreen
//             savedOutfits={savedOutfits}
//             onDelete={deleteOutfit}
//             onToggleFavorite={toggleOutfitFavorite}
//           />
//         );
//       case 'Settings':
//         console.log('🔁 Rendering Settings. history:', screenHistory.current);
//         return <SettingsScreen navigate={navigate} />;

//       case 'Notifications':
//         return <NotificationsScreen navigate={navigate} />;
//       case 'Preferences':
//         return <PreferencesScreen navigate={navigate} />;
//       case 'Measurements':
//         return <MeasurementsScreen navigate={navigate} />;
//       case 'TryOnOverlay':
//         return <TryOnOverlayWrapperScreen screenParams={screenParams} />;
//       case 'BudgetAndBrands':
//         return <BudgetAndBrandsScreen navigate={navigate} />;
//       case 'Appearance':
//         return <AppearanceScreen navigate={navigate} />;
//       case 'ContactScreen':
//         return <ContactScreen navigate={navigate} />;
//       case 'FeedbackScreen':
//         return <FeedbackScreen navigate={navigate} />;
//       case 'AboutScreen':
//         return <AboutScreen navigate={navigate} />;
//       case 'WebPageScreen':
//         return (
//           <WebPageScreen route={{params: screenParams}} navigate={navigate} />
//         );
//       case 'Lifestyle':
//         return <LifestyleScreen navigate={navigate} />;
//       case 'ShoppingHabits':
//         return <ShoppingHabitScreen navigate={navigate} />;
//       case 'AiStylistChatScreen':
//         return <AiStylistChatScreen navigate={navigate} />;
//       case 'Activities':
//         return <ActivitiesScreen navigate={navigate} />;
//       case 'BodyTypes':
//         return <BodyTypesScreen navigate={navigate} />;
//       case 'Climate':
//         return <ClimateScreen navigate={navigate} />;
//       case 'ColorPreferences':
//         return <ColorPreferencesScreen navigate={navigate} />;
//       case 'EyeColor':
//         return <EyeColorScreen navigate={navigate} />;
//       case 'FashionGoals':
//         return <FashionGoalsScreen navigate={navigate} />;
//       case 'FitPreferences':
//         return <FitPreferencesScreen navigate={navigate} />;
//       case 'HairColor':
//         return <HairColorScreen navigate={navigate} />;
//       case 'PersonalityTraits':
//         return <PersonalityTraitsScreen navigate={navigate} />;
//       case 'Proportions':
//         return <ProportionsScreen navigate={navigate} />;
//       case 'SkinTone':
//         return <SkinToneScreen navigate={navigate} />;
//       case 'StyleIcon':
//         return <StyleIconsScreen navigate={navigate} />;
//       case 'Planner':
//         return <CalendarPlannerScreen />;
//       case 'Undertone':
//         return <UndertoneScreen navigate={navigate} />;
//       case 'StyleKeywords':
//         return <StyleKeywordsScreen navigate={navigate} />;
//       case 'Onboarding':
//         return <OnboardingScreen navigate={navigate} />;
//       case 'PersonalInformation':
//         return <PersonalInformationScreen navigate={navigate} />;
//       case 'ItemDetail':
//         return (
//           <ItemDetailScreen
//             route={{params: screenParams}}
//             navigation={{goBack}}
//           />
//         );
//       case 'AddItem':
//         return <AddItemScreen navigate={navigate} addItem={addToWardrobe} />;
//       case 'Outfit':
//         return <OutfitSuggestionScreen navigate={navigate} />;
//       case 'Search':
//         return (
//           <SearchScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             goBack={goBack}
//           />
//         );
//       default:
//         return (
//           <HomeScreen
//             key={screenParams?.__forceRemount}
//             navigate={navigate}
//             wardrobe={wardrobe}
//           />
//         );
//     }
//   };

//   return (
//     <View
//       style={[styles.container, {backgroundColor: theme.colors.background}]}>
//       <LayoutWrapper
//         navigate={navigate}
//         hideHeader={screensWithNoHeader.includes(currentScreen)}
//         showSettings={screensWithSettings.includes(currentScreen)}>
//         <GlobalGestureHandler onEdgeSwipeBack={goBack}>
//           <View style={styles.screen}>{renderScreen()}</View>
//         </GlobalGestureHandler>
//       </LayoutWrapper>

//       {/* ✅ Always visible when logged in */}
//       {currentScreen !== 'Login' && currentScreen !== 'Onboarding' && (
//         <>
//           <BottomNavigation current={currentScreen} navigate={navigate} />
//           {/* <VoiceMicButton navigate={navigate} /> */}
//         </>
//       )}
//     </View>
//   );
// };

// export default RootNavigator;

//////////////////

// import React, {useState, useEffect, useRef} from 'react';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {View, StyleSheet, TouchableOpacity, Text} from 'react-native';

// import HomeScreen from '../screens/HomeScreen';
// import ProfileScreen from '../screens/ProfileScreen';
// import ExploreScreen from '../screens/ExploreScreen';
// import ClosetScreen from '../screens/ClosetScreen';
// import SettingsScreen from '../screens/SettingsScreen';
// import AddItemScreen from '../screens/AddItemScreen';
// import ItemDetailScreen from '../components/ItemDetailScreen/ItemDetailScreen';
// import OutfitSuggestionScreen from '../screens/OutfitSuggestionScreen';
// import SearchScreen from '../screens/SearchScreen';
// import LoginScreen from '../screens/LoginScreen';
// import StyleProfileScreen from '../screens/StyleProfileScreen';
// import PreferencesScreen from '../screens/PreferencesScreen';
// import MeasurementsScreen from '../screens/MeasurementsScreen';
// import BudgetAndBrandsScreen from '../screens/BudgetAndBrandsScreen';
// import AppearanceScreen from '../screens/AppearanceScreen';
// import LifestyleScreen from '../screens/LifestyleScreen';
// import ActivitiesScreen from '../screens/ActivitiesScreen';
// import BodyTypesScreen from '../screens/BodyTypesScreen';
// import ClimateScreen from '../screens/ClimateScreen';
// import ColorPreferencesScreen from '../screens/ColorPreferencesScreen';
// import EyeColorScreen from '../screens/EyeColorScreen';
// import FashionGoalsScreen from '../screens/FashionGoalsScreen';
// import FitPreferencesScreen from '../screens/FitPreferencesScreen';
// import HairColorScreen from '../screens/HairColorScreen';
// import PersonalityTraitsScreen from '../screens/PersonalityTraitsScreen';
// import ProportionsScreen from '../screens/ProportionsScreen';
// import ShoppingHabitScreen from '../screens/ShoppingHabitScreen';
// import SkinToneScreen from '../screens/SkinToneScreen';
// import StyleIconsScreen from '../screens/StyleIconsScreen';
// import OutfitBuilderScreen from '../screens/OutfitBuilderScreen';
// import SavedOutfitsScreen from '../screens/SavedOutfitsScreen';
// import {useSavedOutfits} from '../hooks/useSavedOutfits';
// import TryOnOverlayWrapperScreen from '../screens/TryOnOverlayWrapperScreen';
// import CalendarPlannerScreen from '../screens/CalendarPlannerScreen';
// import NotificationsScreen from '../screens/NotificationsScreen';
// import UndertoneScreen from '../screens/UndertoneScreen';
// import StyleKeywordsScreen from '../screens/StyleKeywordsScreen';
// import OnboardingScreen from '../screens/OnboardingScreen';
// import PersonalInformationScreen from '../screens/PersonalInformationScreen';
// import AiStylistChatScreen from '../screens/AiStyleChatScreen';
// import ContactScreen from '../screens/ContactScreen';
// import AboutScreen from '../screens/AboutScreen';
// import FeedbackScreen from '../screens/FeedBackScreen';
// import WebPageScreen from '../screens/WebPageScreen';
// import RecreatedLookScreen from '../screens/RecreatedLookScreen';
// import BarcodeScannerScreen from '../screens/BarcodeScannerScreen';

// import BottomNavigation from '../components/BottomNavigation/BottomNavigation';
// import LayoutWrapper from '../components/LayoutWrapper/LayoutWrapper';

// import {useAppTheme} from '../context/ThemeContext';
// import {mockClothingItems} from '../components/mockClothingItems/mockClothingItems';
// import {WardrobeItem} from '../hooks/useOutfitSuggestion';
// import GlobalGestureHandler from '../components/Gestures/GlobalGestureHandler';

// import VoiceMicButton from '../components/VoiceMicButton/VoiceMicButton';

// import ReactNativeBiometrics from 'react-native-biometrics';
// import {useAuth0} from 'react-native-auth0';

// type Screen =
//   | 'Login'
//   | 'Home'
//   | 'Profile'
//   | 'StyleProfileScreen'
//   | 'Explore'
//   | 'Wardrobe'
//   | 'Settings'
//   | 'Preferences'
//   | 'BarcodeScannerScreen'
//   | 'Measurements'
//   | 'BudgetAndBrands'
//   | 'Appearance'
//   | 'Lifestyle'
//   | 'ShoppingHabits'
//   | 'StyleSummary'
//   | 'Activities'
//   | 'BodyTypes'
//   | 'Climate'
//   | 'ColorPreferences'
//   | 'EyeColor'
//   | 'FashionGoals'
//   | 'FitPreferences'
//   | 'HairColor'
//   | 'PersonalityTraits'
//   | 'PreferenceStrength'
//   | 'Proportions'
//   | 'SearchScreen'
//   | 'SkinTone'
//   | 'StyleIcon'
//   | 'Voice'
//   | 'ItemDetail'
//   | 'AddItem'
//   | 'Outfit'
//   | 'Search'
//   | 'OutfitBuilder'
//   | 'SavedOutfits'
//   | 'TryOnOverlay'
//   | 'Notifications'
//   | 'Undertone'
//   | 'StyleKeywords'
//   | 'Onboarding'
//   | 'PersonalInformation'
//   | 'ContactScreen'
//   | 'AboutScreen'
//   | 'FeedbackScreen'
//   | 'AiStylistChatScreen'
//   | 'RecreatedLook'
//   | 'WebPageScreen'
//   | 'Planner';

// const RootNavigator = () => {
//   const [currentScreen, setCurrentScreen] = useState<Screen>('Login');
//   const [screenParams, setScreenParams] = useState<any>(null);
//   const [wardrobe, setWardrobe] = useState<WardrobeItem[]>(mockClothingItems);

//   const screensWithNoHeader = ['Login', 'ItemDetail', 'AddItem', 'Home'];
//   const screensWithSettings = ['Profile'];

//   const screenHistory = useRef<Screen[]>([]); // ✅ full navigation history stack
//   const isGoingBackRef = useRef(false);

//   const profileScreenCache = useRef<JSX.Element | null>(null);

//   const {theme} = useAppTheme();
//   const {authorize} = useAuth0();
//   const rnBiometrics = new ReactNativeBiometrics();

//   const styles = StyleSheet.create({
//     container: {
//       flex: 1,
//     },
//     screen: {
//       flex: 1,
//     },
//     debugButton: {
//       position: 'absolute',
//       top: 55,
//       right: 145,
//       backgroundColor: '#007AFF',
//       paddingVertical: 4,
//       paddingHorizontal: 10,
//       borderRadius: 8,
//       zIndex: 999,
//     },
//     debugButtonText: {
//       color: 'white',
//       fontWeight: '700',
//     },
//   });

//   const user = {
//     name: 'Mike Giffin',
//     avatarUrl: 'https://placekitten.com/300/300',
//   };

//   const navigate = (screen: Screen, params?: any) => {
//     if (isGoingBackRef.current) {
//       console.log('⏩ Skipping push because we just went back');
//       isGoingBackRef.current = false;
//     } else if (screen !== currentScreen) {
//       console.log('📍 Pushing current to history:', currentScreen);
//       screenHistory.current.push(currentScreen);
//     } else {
//       console.log('⚠️ Skipped push because screen is same:', screen);
//     }

//     setCurrentScreen(screen);
//     setScreenParams(params || null);
//   };

//   const addToWardrobe = (item: any) => {
//     const newItem = {
//       ...item,
//       favorite: false,
//     };
//     setWardrobe(prev => [newItem, ...prev]);
//     setCurrentScreen('Wardrobe');
//   };

//   const toggleFavorite = (id: string) => {
//     setWardrobe(prev =>
//       prev.map(item =>
//         item.id === id ? {...item, favorite: !item.favorite} : item,
//       ),
//     );
//   };

//   const {
//     savedOutfits,
//     saveOutfit,
//     deleteOutfit,
//     toggleFavorite: toggleOutfitFavorite,
//   } = useSavedOutfits();

//   const routeAfterLogin = async () => {
//     try {
//       const [[, logged], [, onboarded]] = await AsyncStorage.multiGet([
//         'auth_logged_in',
//         'onboarding_complete',
//       ]);
//       if (logged === 'true') {
//         setCurrentScreen(onboarded === 'true' ? 'Home' : 'Onboarding');
//       } else {
//         setCurrentScreen('Login');
//       }
//     } catch {
//       setCurrentScreen('Home');
//     }
//   };

//   const goBack = () => {
//     console.log('⬅️ goBack called, history:', screenHistory.current);

//     global.goingBack = false;
//     isGoingBackRef.current = true;

//     const prev = screenHistory.current.pop();
//     if (!prev) {
//       console.warn('⚠️ History empty, defaulting to Home');
//       setCurrentScreen('Home');
//       return;
//     }

//     console.log('🔙 Navigating back to:', prev);
//     setScreenParams({__forceRemount: Date.now()});
//     setCurrentScreen(prev);
//   };

//   // ✅ Register global goBack for gestures
//   useEffect(() => {
//     global.__rootGoBack = goBack;
//     console.log('🌍 Global goBack registered');
//     return () => {
//       global.__rootGoBack = undefined;
//     };
//   }, []);

//   useEffect(() => {
//     routeAfterLogin();
//   }, []);

//   const renderScreen = () => {
//     switch (currentScreen) {
//       case 'Login':
//         return (
//           <LoginScreen
//             onLoginSuccess={routeAfterLogin}
//             email={''}
//             onGoogleLogin={() => {}}
//             onPasswordLogin={() => {}}
//             onFaceIdLogin={async () => {
//               try {
//                 const result = await rnBiometrics.simplePrompt({
//                   promptMessage: 'Log in with Face ID',
//                 });

//                 if (result.success) {
//                   const redirectUrl =
//                     'com.stylhelpr.stylhelpr.auth0://dev-xeaol4s5b2zd7wuz.us.auth0.com/ios/com.stylhelpr.stylhelpr/callback';

//                   await authorize({redirectUrl});
//                   await routeAfterLogin();
//                 } else {
//                   console.log('Face ID cancelled');
//                 }
//               } catch (e) {
//                 console.error('Face ID login error:', e);
//               }
//             }}
//           />
//         );

//       case 'Profile':
//         if (!profileScreenCache.current) {
//           profileScreenCache.current = (
//             <ProfileScreen
//               navigate={navigate}
//               user={user}
//               wardrobe={wardrobe}
//             />
//           );
//         }
//         return profileScreenCache.current;

//       case 'RecreatedLook':
//         console.log('🧩 Rendering RecreatedLookScreen OVER Home');

//         const safeNav = {
//           navigate,
//           goBack: () => {
//             console.log('⬅️ [RootNavigator] goBack triggered');
//             if (global.showAllSavedLooksModal) {
//               console.log('🪄 Triggering global.showAllSavedLooksModal()...');
//               global.showAllSavedLooksModal();
//             } else if (global.__rootGoBack) {
//               global.__rootGoBack();
//             } else {
//               console.warn('[RootNavigator] No global goBack handler found');
//             }
//           },
//         };

//         return (
//           <View style={{flex: 1}}>
//             <HomeScreen navigate={navigate} />
//             <View style={{...StyleSheet.absoluteFillObject, zIndex: 999}}>
//               <RecreatedLookScreen
//                 route={{params: screenParams}}
//                 navigation={safeNav} // 👈 pass a safe shim
//               />
//             </View>
//           </View>
//         );

//       case 'StyleProfileScreen':
//         return <StyleProfileScreen navigate={navigate} />;
//       case 'BarcodeScannerScreen':
//         return <BarcodeScannerScreen navigate={navigate} />;
//       case 'Explore':
//         return <ExploreScreen navigate={navigate} />;
//       case 'Wardrobe':
//         return (
//           <ClosetScreen
//             key={wardrobe.length}
//             navigate={navigate}
//             wardrobe={screenParams?.updatedWardrobe || wardrobe}
//             toggleFavorite={toggleFavorite}
//           />
//         );

//       case 'OutfitBuilder':
//         return (
//           <OutfitBuilderScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             saveOutfit={saveOutfit}
//           />
//         );
//       case 'SavedOutfits':
//         return (
//           <SavedOutfitsScreen
//             savedOutfits={savedOutfits}
//             onDelete={deleteOutfit}
//             onToggleFavorite={toggleOutfitFavorite}
//           />
//         );
//       case 'Settings':
//         console.log('🔁 Rendering Settings. history:', screenHistory.current);
//         return <SettingsScreen navigate={navigate} />;

//       case 'Notifications':
//         return <NotificationsScreen navigate={navigate} />;
//       case 'Preferences':
//         return <PreferencesScreen navigate={navigate} />;
//       case 'Measurements':
//         return <MeasurementsScreen navigate={navigate} />;
//       case 'TryOnOverlay':
//         return <TryOnOverlayWrapperScreen screenParams={screenParams} />;
//       case 'BudgetAndBrands':
//         return <BudgetAndBrandsScreen navigate={navigate} />;
//       case 'Appearance':
//         return <AppearanceScreen navigate={navigate} />;
//       case 'ContactScreen':
//         return <ContactScreen navigate={navigate} />;
//       case 'FeedbackScreen':
//         return <FeedbackScreen navigate={navigate} />;
//       case 'AboutScreen':
//         return <AboutScreen navigate={navigate} />;
//       case 'WebPageScreen':
//         return (
//           <WebPageScreen route={{params: screenParams}} navigate={navigate} />
//         );
//       case 'Lifestyle':
//         return <LifestyleScreen navigate={navigate} />;
//       case 'ShoppingHabits':
//         return <ShoppingHabitScreen navigate={navigate} />;
//       case 'AiStylistChatScreen':
//         return <AiStylistChatScreen navigate={navigate} />;
//       case 'Activities':
//         return <ActivitiesScreen navigate={navigate} />;
//       case 'BodyTypes':
//         return <BodyTypesScreen navigate={navigate} />;
//       case 'Climate':
//         return <ClimateScreen navigate={navigate} />;
//       case 'ColorPreferences':
//         return <ColorPreferencesScreen navigate={navigate} />;
//       case 'EyeColor':
//         return <EyeColorScreen navigate={navigate} />;
//       case 'FashionGoals':
//         return <FashionGoalsScreen navigate={navigate} />;
//       case 'FitPreferences':
//         return <FitPreferencesScreen navigate={navigate} />;
//       case 'HairColor':
//         return <HairColorScreen navigate={navigate} />;
//       case 'PersonalityTraits':
//         return <PersonalityTraitsScreen navigate={navigate} />;
//       case 'Proportions':
//         return <ProportionsScreen navigate={navigate} />;
//       case 'SkinTone':
//         return <SkinToneScreen navigate={navigate} />;
//       case 'StyleIcon':
//         return <StyleIconsScreen navigate={navigate} />;
//       case 'Planner':
//         return <CalendarPlannerScreen />;
//       case 'Undertone':
//         return <UndertoneScreen navigate={navigate} />;
//       case 'StyleKeywords':
//         return <StyleKeywordsScreen navigate={navigate} />;
//       case 'Onboarding':
//         return <OnboardingScreen navigate={navigate} />;
//       case 'PersonalInformation':
//         return <PersonalInformationScreen navigate={navigate} />;
//       case 'ItemDetail':
//         return (
//           <ItemDetailScreen
//             route={{params: screenParams}}
//             navigation={{goBack}}
//           />
//         );
//       case 'AddItem':
//         return <AddItemScreen navigate={navigate} addItem={addToWardrobe} />;
//       case 'Outfit':
//         return <OutfitSuggestionScreen navigate={navigate} />;
//       case 'Search':
//         return (
//           <SearchScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             goBack={goBack}
//           />
//         );
//       default:
//         return (
//           <HomeScreen
//             key={screenParams?.__forceRemount}
//             navigate={navigate}
//             wardrobe={wardrobe}
//           />
//         );
//     }
//   };

//   return (
//     <View
//       style={[styles.container, {backgroundColor: theme.colors.background}]}>
//       <LayoutWrapper
//         navigate={navigate}
//         hideHeader={screensWithNoHeader.includes(currentScreen)}
//         showSettings={screensWithSettings.includes(currentScreen)}>
//         <GlobalGestureHandler onEdgeSwipeBack={goBack}>
//           <View style={styles.screen}>{renderScreen()}</View>
//         </GlobalGestureHandler>
//       </LayoutWrapper>

//       {/* ✅ Always visible when logged in */}
//       {currentScreen !== 'Login' && currentScreen !== 'Onboarding' && (
//         <>
//           <BottomNavigation current={currentScreen} navigate={navigate} />
//           {/* <VoiceMicButton navigate={navigate} /> */}
//         </>
//       )}
//     </View>
//   );
// };

// export default RootNavigator;

///////////////////

// import React, {useState, useEffect} from 'react';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {View, StyleSheet, TouchableOpacity, Text} from 'react-native';

// import HomeScreen from '../screens/HomeScreen';
// import ProfileScreen from '../screens/ProfileScreen';
// import ExploreScreen from '../screens/ExploreScreen';
// import ClosetScreen from '../screens/ClosetScreen';
// import SettingsScreen from '../screens/SettingsScreen';
// import AddItemScreen from '../screens/AddItemScreen';
// import ItemDetailScreen from '../components/ItemDetailScreen/ItemDetailScreen';
// import OutfitSuggestionScreen from '../screens/OutfitSuggestionScreen';
// import SearchScreen from '../screens/SearchScreen';
// import LoginScreen from '../screens/LoginScreen';
// import StyleProfileScreen from '../screens/StyleProfileScreen';
// import PreferencesScreen from '../screens/PreferencesScreen';
// import MeasurementsScreen from '../screens/MeasurementsScreen';
// import BudgetAndBrandsScreen from '../screens/BudgetAndBrandsScreen';
// import AppearanceScreen from '../screens/AppearanceScreen';
// import LifestyleScreen from '../screens/LifestyleScreen';
// import ActivitiesScreen from '../screens/ActivitiesScreen';
// import BodyTypesScreen from '../screens/BodyTypesScreen';
// import ClimateScreen from '../screens/ClimateScreen';
// import ColorPreferencesScreen from '../screens/ColorPreferencesScreen';
// import EyeColorScreen from '../screens/EyeColorScreen';
// import FashionGoalsScreen from '../screens/FashionGoalsScreen';
// import FitPreferencesScreen from '../screens/FitPreferencesScreen';
// import HairColorScreen from '../screens/HairColorScreen';
// import PersonalityTraitsScreen from '../screens/PersonalityTraitsScreen';
// import ProportionsScreen from '../screens/ProportionsScreen';
// import ShoppingHabitScreen from '../screens/ShoppingHabitScreen';
// import SkinToneScreen from '../screens/SkinToneScreen';
// import StyleIconsScreen from '../screens/StyleIconsScreen';
// import OutfitBuilderScreen from '../screens/OutfitBuilderScreen';
// import SavedOutfitsScreen from '../screens/SavedOutfitsScreen';
// import {useSavedOutfits} from '../hooks/useSavedOutfits';
// import TryOnOverlayWrapperScreen from '../screens/TryOnOverlayWrapperScreen';
// import CalendarPlannerScreen from '../screens/CalendarPlannerScreen';
// import NotificationsScreen from '../screens/NotificationsScreen';
// import UndertoneScreen from '../screens/UndertoneScreen';
// import StyleKeywordsScreen from '../screens/StyleKeywordsScreen';
// import OnboardingScreen from '../screens/OnboardingScreen';
// import PersonalInformationScreen from '../screens/PersonalInformationScreen';
// import AiStylistChatScreen from '../screens/AiStyleChatScreen';
// import ContactScreen from '../screens/ContactScreen';
// import AboutScreen from '../screens/AboutScreen';
// import FeedbackScreen from '../screens/FeedBackScreen';
// import WebPageScreen from '../screens/WebPageScreen';

// import BottomNavigation from '../components/BottomNavigation/BottomNavigation';
// import LayoutWrapper from '../components/LayoutWrapper/LayoutWrapper';

// import {useAppTheme} from '../context/ThemeContext';
// import {mockClothingItems} from '../components/mockClothingItems/mockClothingItems';
// import {WardrobeItem} from '../hooks/useOutfitSuggestion';

// import ReactNativeBiometrics from 'react-native-biometrics';
// import {useAuth0} from 'react-native-auth0';

// type Screen =
//   | 'Login'
//   | 'Home'
//   | 'Profile'
//   | 'StyleProfileScreen'
//   | 'Explore'
//   | 'Wardrobe'
//   | 'Settings'
//   | 'Preferences'
//   | 'Measurements'
//   | 'BudgetAndBrands'
//   | 'Appearance'
//   | 'Lifestyle'
//   | 'ShoppingHabits'
//   | 'StyleSummary'
//   | 'Activities'
//   | 'BodyTypes'
//   | 'Climate'
//   | 'ColorPreferences'
//   | 'EyeColor'
//   | 'FashionGoals'
//   | 'FitPreferences'
//   | 'HairColor'
//   | 'PersonalityTraits'
//   | 'PreferenceStrength'
//   | 'Proportions'
//   | 'SearchScreen'
//   | 'SkinTone'
//   | 'StyleIcon'
//   | 'Voice'
//   | 'ItemDetail'
//   | 'AddItem'
//   | 'Outfit'
//   | 'Search'
//   | 'OutfitBuilder'
//   | 'SavedOutfits'
//   | 'TryOnOverlay'
//   | 'Notifications'
//   | 'Undertone'
//   | 'StyleKeywords'
//   | 'Onboarding'
//   | 'PersonalInformation'
//   | 'ContactScreen'
//   | 'AboutScreen'
//   | 'FeedbackScreen'
//   | 'AiStylistChatScreen'
//   | 'WebPageScreen'
//   | 'Planner';

// const RootNavigator = () => {
//   const [currentScreen, setCurrentScreen] = useState<Screen>('Login');
//   const [prevScreen, setPrevScreen] = useState<Screen>('Home');
//   const [screenParams, setScreenParams] = useState<any>(null);
//   const [wardrobe, setWardrobe] = useState<WardrobeItem[]>(mockClothingItems);

//   const screensWithNoHeader = ['Login', 'ItemDetail', 'AddItem', 'Home'];
//   const screensWithSettings = ['Profile'];

//   const {theme} = useAppTheme();
//   const {authorize} = useAuth0();
//   const rnBiometrics = new ReactNativeBiometrics();

//   const styles = StyleSheet.create({
//     container: {
//       flex: 1,
//     },
//     screen: {
//       flex: 1,
//     },
//     debugButton: {
//       position: 'absolute',
//       top: 55,
//       right: 145,
//       backgroundColor: '#007AFF',
//       paddingVertical: 4,
//       paddingHorizontal: 10,
//       borderRadius: 8,
//       zIndex: 999,
//     },
//     debugButtonText: {
//       color: 'white',
//       fontWeight: '700',
//     },
//   });

//   const user = {
//     name: 'Mike Giffin',
//     avatarUrl: 'https://placekitten.com/300/300',
//   };

//   const navigate = (screen: Screen, params?: any) => {
//     setPrevScreen(currentScreen);
//     setCurrentScreen(screen);
//     setScreenParams(params || null);
//   };

//   const addToWardrobe = (item: any) => {
//     const newItem = {
//       ...item,
//       favorite: false,
//     };
//     setWardrobe(prev => [newItem, ...prev]);
//     setCurrentScreen('Wardrobe');
//   };

//   const toggleFavorite = (id: string) => {
//     setWardrobe(prev =>
//       prev.map(item =>
//         item.id === id ? {...item, favorite: !item.favorite} : item,
//       ),
//     );
//   };

//   const {
//     savedOutfits,
//     saveOutfit,
//     deleteOutfit,
//     toggleFavorite: toggleOutfitFavorite,
//   } = useSavedOutfits();

//   const routeAfterLogin = async () => {
//     try {
//       const [[, logged], [, onboarded]] = await AsyncStorage.multiGet([
//         'auth_logged_in',
//         'onboarding_complete',
//       ]);
//       if (logged === 'true') {
//         setCurrentScreen(onboarded === 'true' ? 'Home' : 'Onboarding');
//       } else {
//         setCurrentScreen('Login');
//       }
//     } catch {
//       // If anything is weird, fall back to Home
//       setCurrentScreen('Home');
//     }
//   };

//   useEffect(() => {
//     routeAfterLogin();
//   }, []);

//   const renderScreen = () => {
//     switch (currentScreen) {
//       case 'Login':
//         return (
//           <LoginScreen
//             onLoginSuccess={routeAfterLogin}
//             email={''}
//             onGoogleLogin={() => {}}
//             onPasswordLogin={() => {}}
//             onFaceIdLogin={async () => {
//               try {
//                 const result = await rnBiometrics.simplePrompt({
//                   promptMessage: 'Log in with Face ID',
//                 });

//                 if (result.success) {
//                   const redirectUrl =
//                     'com.stylhelpr.stylhelpr.auth0://dev-xeaol4s5b2zd7wuz.us.auth0.com/ios/com.stylhelpr.stylhelpr/callback';

//                   await authorize({redirectUrl});
//                   await routeAfterLogin();
//                 } else {
//                   console.log('Face ID cancelled');
//                 }
//               } catch (e) {
//                 console.error('Face ID login error:', e);
//               }
//             }}
//           />
//         );

//       case 'Profile':
//         return (
//           <ProfileScreen navigate={navigate} user={user} wardrobe={wardrobe} />
//         );
//       case 'StyleProfileScreen':
//         return <StyleProfileScreen navigate={navigate} />;
//       case 'Explore':
//         return <ExploreScreen navigate={navigate} />;
//       case 'Wardrobe':
//         return (
//           <ClosetScreen
//             key={wardrobe.length}
//             navigate={navigate}
//             wardrobe={screenParams?.updatedWardrobe || wardrobe}
//             toggleFavorite={toggleFavorite}
//           />
//         );
//       case 'OutfitBuilder':
//         return (
//           <OutfitBuilderScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             saveOutfit={saveOutfit}
//           />
//         );
//       case 'SavedOutfits':
//         return (
//           <SavedOutfitsScreen
//             savedOutfits={savedOutfits}
//             onDelete={deleteOutfit}
//             onToggleFavorite={toggleOutfitFavorite}
//           />
//         );
//       case 'Settings':
//         return <SettingsScreen navigate={navigate} />;
//       case 'Notifications':
//         return <NotificationsScreen navigate={navigate} />;
//       case 'Preferences':
//         return <PreferencesScreen navigate={navigate} />;
//       case 'Measurements':
//         return <MeasurementsScreen navigate={navigate} />;
//       case 'TryOnOverlay':
//         return <TryOnOverlayWrapperScreen screenParams={screenParams} />;
//       case 'BudgetAndBrands':
//         return <BudgetAndBrandsScreen navigate={navigate} />;
//       case 'Appearance':
//         return <AppearanceScreen navigate={navigate} />;
//       case 'ContactScreen':
//         return <ContactScreen navigate={navigate} />;
//       case 'FeedbackScreen':
//         return <FeedbackScreen navigate={navigate} />;
//       case 'AboutScreen':
//         return <AboutScreen navigate={navigate} />;
//       case 'WebPageScreen':
//         return (
//           <WebPageScreen route={{params: screenParams}} navigate={navigate} />
//         );
//       case 'Lifestyle':
//         return <LifestyleScreen navigate={navigate} />;
//       case 'ShoppingHabits':
//         return <ShoppingHabitScreen navigate={navigate} />;
//       case 'AiStylistChatScreen':
//         return <AiStylistChatScreen navigate={navigate} />;
//       case 'Activities':
//         return <ActivitiesScreen navigate={navigate} />;
//       case 'BodyTypes':
//         return <BodyTypesScreen navigate={navigate} />;
//       case 'Climate':
//         return <ClimateScreen navigate={navigate} />;
//       case 'ColorPreferences':
//         return <ColorPreferencesScreen navigate={navigate} />;
//       case 'EyeColor':
//         return <EyeColorScreen navigate={navigate} />;
//       case 'FashionGoals':
//         return <FashionGoalsScreen navigate={navigate} />;
//       case 'FitPreferences':
//         return <FitPreferencesScreen navigate={navigate} />;
//       case 'HairColor':
//         return <HairColorScreen navigate={navigate} />;
//       case 'PersonalityTraits':
//         return <PersonalityTraitsScreen navigate={navigate} />;
//       case 'Proportions':
//         return <ProportionsScreen navigate={navigate} />;
//       case 'SkinTone':
//         return <SkinToneScreen navigate={navigate} />;
//       case 'StyleIcon':
//         return <StyleIconsScreen navigate={navigate} />;
//       case 'Planner':
//         return <CalendarPlannerScreen />;
//       case 'Undertone':
//         return <UndertoneScreen navigate={navigate} />;
//       case 'StyleKeywords':
//         return <StyleKeywordsScreen navigate={navigate} />;
//       case 'Onboarding':
//         return <OnboardingScreen navigate={navigate} />;
//       case 'PersonalInformation':
//         return <PersonalInformationScreen navigate={navigate} />;
//       case 'ItemDetail':
//         return (
//           <ItemDetailScreen
//             route={{params: screenParams}}
//             navigation={{goBack: () => setCurrentScreen('Wardrobe')}}
//           />
//         );
//       case 'AddItem':
//         return <AddItemScreen navigate={navigate} addItem={addToWardrobe} />;
//       case 'Outfit':
//         return <OutfitSuggestionScreen navigate={navigate} />;
//       case 'Search':
//         return (
//           <SearchScreen
//             wardrobe={wardrobe}
//             navigate={navigate}
//             goBack={() => setCurrentScreen(prevScreen)}
//           />
//         );
//       default:
//         return <HomeScreen navigate={navigate} wardrobe={wardrobe} />;
//     }
//   };

//   return (
//     <View
//       style={[styles.container, {backgroundColor: theme.colors.background}]}>
//       <LayoutWrapper
//         navigate={navigate}
//         hideHeader={screensWithNoHeader.includes(currentScreen)}
//         showSettings={screensWithSettings.includes(currentScreen)}>
//         <View style={styles.screen}>{renderScreen()}</View>
//       </LayoutWrapper>

//       {currentScreen !== 'Login' && currentScreen !== 'Onboarding' ? (
//         <BottomNavigation current={currentScreen} navigate={navigate} />
//       ) : null}
//     </View>
//   );
// };

// export default RootNavigator;
