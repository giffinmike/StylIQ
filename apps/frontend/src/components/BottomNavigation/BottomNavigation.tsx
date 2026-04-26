import React, {useRef, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ViewStyle,
  TextStyle,
  Platform,
  Animated,
  Easing,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
import {useAppTheme} from '../../context/ThemeContext';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
import {fontScale, moderateScale} from '../../utils/scale';
import {tokens} from '../../styles/tokens/tokens';

interface TabButtonProps {
  icon: string;
  label: string;
  onPress: () => void;
  isActive?: boolean;
}

type Props = {
  current: string;
  navigate: (screen: string) => void;
  scrollY?: Animated.Value;
};

// Height of the nav bar + safe area for translation
const NAV_HEIGHT = 100;
// Minimum scroll delta to trigger show/hide (lower = more sensitive)
const SCROLL_THRESHOLD = 3;

const BottomNavigation = ({current, navigate, scrollY}: Props) => {
  const {theme} = useAppTheme();
  const insets = useSafeAreaInsets();

  // Detect if device has home button (no home indicator = small bottom inset)
  const hasHomeButton = insets.bottom < 20;

  // Animation value for slide in/out
  const translateY = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);
  const isHidden = useRef(false);

  // Reset navbar visibility when navigating to a new screen
  useEffect(() => {
    // Reset scroll position and show navbar on screen change
    if (scrollY) {
      scrollY.setValue(0);
    }
    lastScrollY.current = 0;
    isHidden.current = false;
    Animated.timing(translateY, {
      toValue: 0,
      duration: 250,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [current, scrollY, translateY]);

  // iOS 26-style scroll hide/show behavior
  useEffect(() => {
    if (!scrollY) return;

    const listenerId = scrollY.addListener(({value}) => {
      const diff = value - lastScrollY.current;

      // Scrolling down - hide nav
      if (diff > SCROLL_THRESHOLD && !isHidden.current && value > 10) {
        isHidden.current = true;
        Animated.timing(translateY, {
          toValue: NAV_HEIGHT + insets.bottom,
          duration: 950,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }
      // Scrolling up - show nav
      else if (diff < -SCROLL_THRESHOLD && isHidden.current) {
        isHidden.current = false;
        Animated.timing(translateY, {
          toValue: 0,
          duration: 950,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }

      lastScrollY.current = value;
    });

    return () => {
      scrollY.removeListener(listenerId);
    };
  }, [scrollY, translateY, insets.bottom]);

  const styles = StyleSheet.create<{
    navBar: ViewStyle;
    glassPill: ViewStyle;
    tabButton: ViewStyle;
    tabLabel: TextStyle;
    activeLabel: TextStyle;
  }>({
    navBar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      width: '100%',
      height: 80,
      backgroundColor: 'transparent',
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 999,
      paddingBottom: Platform.OS === 'ios' ? 10 : 6,
    },
    glassPill: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      width: '90%',
      alignSelf: 'center',
      borderRadius: 50,
      height: 62,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.muted,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: {width: 0, height: 4},
      backgroundColor: 'transparent',
      marginBottom: hasHomeButton ? 10 : -14,
    },
    tabButton: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    tabLabel: {
      fontSize: fontScale(tokens.fontSize.xxxs),
      color: theme.colors.buttonText1,
      fontWeight: '400',
    },
    activeLabel: {
      fontSize: fontScale(tokens.fontSize.xxxs),
      color: theme.colors.buttonText1,
    },
  });

  const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
    <AppleTouchFeedback
      style={styles.tabButton}
      hapticStyle={isActive ? undefined : 'impactLight'}
      onPress={onPress}>
      <Icon
        name={icon}
        size={22}
        color={isActive ? theme.colors.button1 : theme.colors.buttonText1}
      />
      <Text
        style={[styles.tabLabel, isActive && styles.activeLabel]}
        numberOfLines={1}>
        {label}
      </Text>
    </AppleTouchFeedback>
  );

  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 999,
        transform: [{translateY}],
      }}>
      <SafeAreaView
        edges={['bottom']}
        style={{
          backgroundColor: 'transparent',
        }}>
        {isLiquidGlassSupported ? (
          <Animated.View style={{opacity: 1, transform: [{translateY}]}}>
            <LiquidGlassView
              style={styles.glassPill}
              effect="clear"
              tintColor="rgba(0, 0, 0, 0.48)"
              colorScheme="system">
              <TabButton
                icon="home"
                label="HOME"
                onPress={() => current !== 'Home' && navigate('Home')}
                isActive={current === 'Home'}
              />
                 <TabButton
                icon="auto-awesome"
                label="OUTFITS"
                onPress={() => current !== 'Outfits' && navigate('Outfits')}
                isActive={current === 'Outfits'}
              />
                 <TabButton
                icon="style"
                label="WARDROBE"
                onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
                isActive={current === 'Wardrobe'}
              />
                 <TabButton
                icon="checkroom"
                label="SAVED"
                onPress={() =>
                  current !== 'SavedOutfits' && navigate('SavedOutfits')
                }
                isActive={current === 'SavedOutfits'}
              />
              <TabButton
                icon="group"
                label="STYLE FEED"
                onPress={() =>
                  current !== 'CommunityShowcaseScreen' &&
                  navigate('CommunityShowcaseScreen')
                }
                isActive={current === 'CommunityShowcaseScreen'}
              />
              {/* <TabButton
                icon="card-travel"
                label="TRIPS"
                onPress={() => current !== 'Trips' && navigate('Trips')}
                isActive={current === 'Trips'}
              /> */}

            </LiquidGlassView>
          </Animated.View>
        ) : (
          // fallback if LiquidGlass unsupported
          <View
            style={[
              styles.glassPill,
              {backgroundColor: 'rgba(0, 0, 0, 0.44)'},
            ]}>
            <TabButton
              icon="home"
              label="Home"
              onPress={() => current !== 'Home' && navigate('Home')}
              isActive={current === 'Home'}
            />
             <TabButton
                icon="auto-awesome"
                label="OUTFITS"
                onPress={() => current !== 'Outfits' && navigate('Outfits')}
                isActive={current === 'Outfits'}
              />
               <TabButton
                icon="style"
                label="WARDROBE"
                onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
                isActive={current === 'Wardrobe'}
              />
                <TabButton
                icon="checkroom"
                label="SAVED"
                onPress={() =>
                  current !== 'SavedOutfits' && navigate('SavedOutfits')
                }
                isActive={current === 'SavedOutfits'}
              />
              <TabButton
                icon="group"
                label="STYLE FEED"
                onPress={() =>
                  current !== 'CommunityShowcaseScreen' &&
                  navigate('CommunityShowcaseScreen')
                }
                isActive={current === 'CommunityShowcaseScreen'}
              />
              {/* <TabButton
                icon="card-travel"
                label="TRIPS"
                onPress={() => current !== 'Trips' && navigate('Trips')}
                isActive={current === 'Trips'}
              /> */}
          </View>
        )}
      </SafeAreaView>
    </Animated.View>
  );
};

export default BottomNavigation;

/////////////

// import React, {useRef, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
//   Easing,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// // Height of the nav bar + safe area for translation
// const NAV_HEIGHT = 100;
// // Minimum scroll delta to trigger show/hide (lower = more sensitive)
// const SCROLL_THRESHOLD = 3;

// const BottomNavigation = ({current, navigate, scrollY}: Props) => {
//   const {theme} = useAppTheme();
//   const insets = useSafeAreaInsets();

//   // Detect if device has home button (no home indicator = small bottom inset)
//   const hasHomeButton = insets.bottom < 20;

//   // Animation value for slide in/out
//   const translateY = useRef(new Animated.Value(0)).current;
//   const lastScrollY = useRef(0);
//   const isHidden = useRef(false);

//   // Reset navbar visibility when navigating to a new screen
//   useEffect(() => {
//     // Reset scroll position and show navbar on screen change
//     if (scrollY) {
//       scrollY.setValue(0);
//     }
//     lastScrollY.current = 0;
//     isHidden.current = false;
//     Animated.timing(translateY, {
//       toValue: 0,
//       duration: 250,
//       easing: Easing.out(Easing.cubic),
//       useNativeDriver: true,
//     }).start();
//   }, [current, scrollY, translateY]);

//   // iOS 26-style scroll hide/show behavior
//   useEffect(() => {
//     if (!scrollY) return;

//     const listenerId = scrollY.addListener(({value}) => {
//       const diff = value - lastScrollY.current;

//       // Scrolling down - hide nav
//       if (diff > SCROLL_THRESHOLD && !isHidden.current && value > 10) {
//         isHidden.current = true;
//         Animated.timing(translateY, {
//           toValue: NAV_HEIGHT + insets.bottom,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }
//       // Scrolling up - show nav
//       else if (diff < -SCROLL_THRESHOLD && isHidden.current) {
//         isHidden.current = false;
//         Animated.timing(translateY, {
//           toValue: 0,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }

//       lastScrollY.current = value;
//     });

//     return () => {
//       scrollY.removeListener(listenerId);
//     };
//   }, [scrollY, translateY, insets.bottom]);

//   const styles = StyleSheet.create<{
//     navBar: ViewStyle;
//     glassPill: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 80,
//       backgroundColor: 'transparent',
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//     },
//     glassPill: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '90%',
//       alignSelf: 'center',
//       borderRadius: 50,
//       height: 62,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.muted,
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.2,
//       shadowRadius: 12,
//       shadowOffset: {width: 0, height: 4},
//       backgroundColor: 'transparent',
//       marginBottom: hasHomeButton ? 10 : -14,
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'center',
//       gap: 4,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '400',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '00',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={styles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <Icon
//         name={icon}
//         size={22}
//         color={isActive ? theme.colors.buttonText1 : theme.colors.buttonText1}
//       />
//       <Text
//         style={[styles.tabLabel, isActive && styles.activeLabel]}
//         numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   return (
//     <Animated.View
//       style={{
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//         transform: [{translateY}],
//       }}>
//       <SafeAreaView
//         edges={['bottom']}
//         style={{
//           backgroundColor: 'transparent',
//         }}>
//         {isLiquidGlassSupported ? (
//           <Animated.View style={{opacity: 1, transform: [{translateY}]}}>
//             <LiquidGlassView
//               style={styles.glassPill}
//               effect="clear"
//               tintColor="rgba(0, 0, 0, 0.48)"
//               colorScheme="system">
//               <TabButton
//                 icon="home"
//                 label="HOME"
//                 onPress={() => current !== 'Home' && navigate('Home')}
//                 isActive={current === 'Home'}
//               />
//               <TabButton
//                 icon="explore"
//                 label="NEWS"
//                 onPress={() => current !== 'Explore' && navigate('Explore')}
//                 isActive={current === 'Explore'}
//               />
//               <TabButton
//                 icon="auto-awesome"
//                 label="STYLE ME"
//                 onPress={() => current !== 'Outfit' && navigate('Outfit')}
//                 isActive={current === 'Outfit'}
//               />
//               <TabButton
//                 icon="style"
//                 label="WARDROBE"
//                 onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//                 isActive={current === 'Wardrobe'}
//               />
//               <TabButton
//                 icon="checkroom"
//                 label="OUTFITS"
//                 onPress={() =>
//                   current !== 'SavedOutfits' && navigate('SavedOutfits')
//                 }
//                 isActive={current === 'SavedOutfits'}
//               />
//             </LiquidGlassView>
//           </Animated.View>
//         ) : (
//           // fallback if LiquidGlass unsupported
//           <View
//             style={[
//               styles.glassPill,
//               {backgroundColor: 'rgba(0, 0, 0, 0.44)'},
//             ]}>
//             <TabButton
//               icon="home"
//               label="Home"
//               onPress={() => current !== 'Home' && navigate('Home')}
//               isActive={current === 'Home'}
//             />
//             <TabButton
//               icon="explore"
//               label="Fashion"
//               onPress={() => current !== 'Explore' && navigate('Explore')}
//               isActive={current === 'Explore'}
//             />
//             <TabButton
//               icon="auto-awesome"
//               label="Style Me"
//               onPress={() => current !== 'Outfit' && navigate('Outfit')}
//               isActive={current === 'Outfit'}
//             />
//             <TabButton
//               icon="style"
//               label="Wardrobe"
//               onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//               isActive={current === 'Wardrobe'}
//             />
//             <TabButton
//               icon="checkroom"
//               label="Saved"
//               onPress={() =>
//                 current !== 'SavedOutfits' && navigate('SavedOutfits')
//               }
//               isActive={current === 'SavedOutfits'}
//             />
//           </View>
//         )}
//       </SafeAreaView>
//     </Animated.View>
//   );
// };

// export default BottomNavigation;

//////////////////

// import React, {useRef, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
//   Easing,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// // Height of the nav bar + safe area for translation
// const NAV_HEIGHT = 100;
// // Minimum scroll delta to trigger show/hide (lower = more sensitive)
// const SCROLL_THRESHOLD = 3;

// const BottomNavigation = ({current, navigate, scrollY}: Props) => {
//   const {theme} = useAppTheme();
//   const insets = useSafeAreaInsets();

//   // Detect if device has home button (no home indicator = small bottom inset)
//   const hasHomeButton = insets.bottom < 20;

//   // Animation value for slide in/out
//   const translateY = useRef(new Animated.Value(0)).current;
//   const lastScrollY = useRef(0);
//   const isHidden = useRef(false);

//   // Reset navbar visibility when navigating to a new screen
//   useEffect(() => {
//     // Reset scroll position and show navbar on screen change
//     if (scrollY) {
//       scrollY.setValue(0);
//     }
//     lastScrollY.current = 0;
//     isHidden.current = false;
//     Animated.timing(translateY, {
//       toValue: 0,
//       duration: 250,
//       easing: Easing.out(Easing.cubic),
//       useNativeDriver: true,
//     }).start();
//   }, [current, scrollY, translateY]);

//   // iOS 26-style scroll hide/show behavior
//   useEffect(() => {
//     if (!scrollY) return;

//     const listenerId = scrollY.addListener(({value}) => {
//       const diff = value - lastScrollY.current;

//       // Scrolling down - hide nav
//       if (diff > SCROLL_THRESHOLD && !isHidden.current && value > 10) {
//         isHidden.current = true;
//         Animated.timing(translateY, {
//           toValue: NAV_HEIGHT + insets.bottom,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }
//       // Scrolling up - show nav
//       else if (diff < -SCROLL_THRESHOLD && isHidden.current) {
//         isHidden.current = false;
//         Animated.timing(translateY, {
//           toValue: 0,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }

//       lastScrollY.current = value;
//     });

//     return () => {
//       scrollY.removeListener(listenerId);
//     };
//   }, [scrollY, translateY, insets.bottom]);

//   const styles = StyleSheet.create<{
//     navBar: ViewStyle;
//     glassPill: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 80,
//       backgroundColor: 'transparent',
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//     },
//     glassPill: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '90%',
//       alignSelf: 'center',
//       borderRadius: 50,
//       height: 62,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.muted,
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.2,
//       shadowRadius: 12,
//       shadowOffset: {width: 0, height: 4},
//       backgroundColor: 'transparent',
//       marginBottom: hasHomeButton ? 10 : -14,
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'center',
//       gap: 4,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={styles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <Icon
//         name={icon}
//         size={26}
//         color={isActive ? theme.colors.buttonText1 : theme.colors.buttonText1}
//       />
//       <Text
//         style={[styles.tabLabel, isActive && styles.activeLabel]}
//         numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   return (
//     <Animated.View
//       style={{
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//         transform: [{translateY}],
//       }}>
//       <SafeAreaView
//         edges={['bottom']}
//         style={{
//           backgroundColor: 'transparent',
//         }}>
//         {isLiquidGlassSupported ? (
//           <Animated.View style={{opacity: 1, transform: [{translateY}]}}>
//             <LiquidGlassView
//               style={styles.glassPill}
//               effect="clear"
//               tintColor="rgba(0, 0, 0, 0.42)"
//               colorScheme="system">
//               <TabButton
//                 icon="home"
//                 label="Home"
//                 onPress={() => current !== 'Home' && navigate('Home')}
//                 isActive={current === 'Home'}
//               />
//               <TabButton
//                 icon="explore"
//                 label="Fashion"
//                 onPress={() => current !== 'Explore' && navigate('Explore')}
//                 isActive={current === 'Explore'}
//               />
//               <TabButton
//                 icon="auto-awesome"
//                 label="Style Me"
//                 onPress={() => current !== 'Outfit' && navigate('Outfit')}
//                 isActive={current === 'Outfit'}
//               />
//               <TabButton
//                 icon="style"
//                 label="Wardrobe"
//                 onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//                 isActive={current === 'Wardrobe'}
//               />
//               <TabButton
//                 icon="checkroom"
//                 label="Saved"
//                 onPress={() =>
//                   current !== 'SavedOutfits' && navigate('SavedOutfits')
//                 }
//                 isActive={current === 'SavedOutfits'}
//               />
//             </LiquidGlassView>
//           </Animated.View>
//         ) : (
//           // fallback if LiquidGlass unsupported
//           <View
//             style={[
//               styles.glassPill,
//               {backgroundColor: 'rgba(0, 0, 0, 0.44)'},
//             ]}>
//             <TabButton
//               icon="home"
//               label="Home"
//               onPress={() => current !== 'Home' && navigate('Home')}
//               isActive={current === 'Home'}
//             />
//             <TabButton
//               icon="explore"
//               label="Fashion"
//               onPress={() => current !== 'Explore' && navigate('Explore')}
//               isActive={current === 'Explore'}
//             />
//             <TabButton
//               icon="auto-awesome"
//               label="Style Me"
//               onPress={() => current !== 'Outfit' && navigate('Outfit')}
//               isActive={current === 'Outfit'}
//             />
//             <TabButton
//               icon="style"
//               label="Wardrobe"
//               onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//               isActive={current === 'Wardrobe'}
//             />
//             <TabButton
//               icon="checkroom"
//               label="Saved"
//               onPress={() =>
//                 current !== 'SavedOutfits' && navigate('SavedOutfits')
//               }
//               isActive={current === 'SavedOutfits'}
//             />
//           </View>
//         )}
//       </SafeAreaView>
//     </Animated.View>
//   );
// };

// export default BottomNavigation;

//////////////////

// import React, {useRef, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
//   Easing,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// // Height of the nav bar + safe area for translation
// const NAV_HEIGHT = 100;
// // Minimum scroll delta to trigger show/hide (lower = more sensitive)
// const SCROLL_THRESHOLD = 3;

// const BottomNavigation = ({current, navigate, scrollY}: Props) => {
//   const {theme} = useAppTheme();
//   const insets = useSafeAreaInsets();

//   // Detect if device has home button (no home indicator = small bottom inset)
//   const hasHomeButton = insets.bottom < 20;

//   // Animation value for slide in/out
//   const translateY = useRef(new Animated.Value(0)).current;
//   const lastScrollY = useRef(0);
//   const isHidden = useRef(false);

//   // iOS 26-style scroll hide/show behavior
//   useEffect(() => {
//     if (!scrollY) return;

//     const listenerId = scrollY.addListener(({value}) => {
//       const diff = value - lastScrollY.current;

//       // Scrolling down - hide nav
//       if (diff > SCROLL_THRESHOLD && !isHidden.current && value > 10) {
//         isHidden.current = true;
//         Animated.timing(translateY, {
//           toValue: NAV_HEIGHT + insets.bottom,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }
//       // Scrolling up - show nav
//       else if (diff < -SCROLL_THRESHOLD && isHidden.current) {
//         isHidden.current = false;
//         Animated.timing(translateY, {
//           toValue: 0,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }

//       lastScrollY.current = value;
//     });

//     return () => {
//       scrollY.removeListener(listenerId);
//     };
//   }, [scrollY, translateY, insets.bottom]);

//   const pillOpacity = scrollY
//     ? scrollY.interpolate({
//         inputRange: [0, 150],
//         outputRange: [0.3, 1],
//         extrapolate: 'clamp',
//       })
//     : 1;

//   const styles = StyleSheet.create<{
//     navBar: ViewStyle;
//     glassPill: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 80,
//       backgroundColor: 'transparent',
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//     },
//     glassPill: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '90%',
//       alignSelf: 'center',
//       borderRadius: 50,
//       height: 62,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.muted,
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.2,
//       shadowRadius: 12,
//       shadowOffset: {width: 0, height: 4},
//       backgroundColor: 'transparent',
//       marginBottom: hasHomeButton ? 10 : -14,
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'center',
//       gap: 4,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={styles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <Icon
//         name={icon}
//         size={26}
//         color={isActive ? theme.colors.buttonText1 : theme.colors.buttonText1}
//       />
//       <Text
//         style={[styles.tabLabel, isActive && styles.activeLabel]}
//         numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   return (
//     <Animated.View
//       style={{
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//         transform: [{translateY}],
//       }}>
//       <SafeAreaView
//         edges={['bottom']}
//         style={{
//           backgroundColor: 'transparent',
//         }}>
//         {isLiquidGlassSupported ? (
//           <Animated.View style={{opacity: pillOpacity}}>
//             <LiquidGlassView
//               style={styles.glassPill}
//               effect="clear"
//               tintColor="rgba(0, 0, 0, 0.42)"
//               colorScheme="system">
//               <TabButton
//                 icon="home"
//                 label="Home"
//                 onPress={() => current !== 'Home' && navigate('Home')}
//                 isActive={current === 'Home'}
//               />
//               <TabButton
//                 icon="explore"
//                 label="Fashion"
//                 onPress={() => current !== 'Explore' && navigate('Explore')}
//                 isActive={current === 'Explore'}
//               />
//               <TabButton
//                 icon="auto-awesome"
//                 label="Style Me"
//                 onPress={() => current !== 'Outfit' && navigate('Outfit')}
//                 isActive={current === 'Outfit'}
//               />
//               <TabButton
//                 icon="style"
//                 label="Wardrobe"
//                 onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//                 isActive={current === 'Wardrobe'}
//               />
//               <TabButton
//                 icon="checkroom"
//                 label="Saved"
//                 onPress={() =>
//                   current !== 'SavedOutfits' && navigate('SavedOutfits')
//                 }
//                 isActive={current === 'SavedOutfits'}
//               />
//             </LiquidGlassView>
//           </Animated.View>
//         ) : (
//           // fallback if LiquidGlass unsupported
//           <View
//             style={[
//               styles.glassPill,
//               {backgroundColor: 'rgba(0, 0, 0, 0.44)'},
//             ]}>
//             <TabButton
//               icon="home"
//               label="Home"
//               onPress={() => current !== 'Home' && navigate('Home')}
//               isActive={current === 'Home'}
//             />
//             <TabButton
//               icon="explore"
//               label="Fashion"
//               onPress={() => current !== 'Explore' && navigate('Explore')}
//               isActive={current === 'Explore'}
//             />
//             <TabButton
//               icon="auto-awesome"
//               label="Style Me"
//               onPress={() => current !== 'Outfit' && navigate('Outfit')}
//               isActive={current === 'Outfit'}
//             />
//             <TabButton
//               icon="style"
//               label="Wardrobe"
//               onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//               isActive={current === 'Wardrobe'}
//             />
//             <TabButton
//               icon="checkroom"
//               label="Saved"
//               onPress={() =>
//                 current !== 'SavedOutfits' && navigate('SavedOutfits')
//               }
//               isActive={current === 'SavedOutfits'}
//             />
//           </View>
//         )}
//       </SafeAreaView>
//     </Animated.View>
//   );
// };

// export default BottomNavigation;

/////////////

// import React, {useRef, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
//   Easing,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// // Height of the nav bar + safe area for translation
// const NAV_HEIGHT = 100;
// // Minimum scroll delta to trigger show/hide (lower = more sensitive)
// const SCROLL_THRESHOLD = 3;

// const BottomNavigation = ({current, navigate, scrollY}: Props) => {
//   const {theme} = useAppTheme();
//   const insets = useSafeAreaInsets();

//   // Detect if device has home button (no home indicator = small bottom inset)
//   const hasHomeButton = insets.bottom < 20;

//   // Animation value for slide in/out
//   const translateY = useRef(new Animated.Value(0)).current;
//   const lastScrollY = useRef(0);
//   const isHidden = useRef(false);

//   // iOS 26-style scroll hide/show behavior
//   useEffect(() => {
//     if (!scrollY) return;

//     const listenerId = scrollY.addListener(({value}) => {
//       const diff = value - lastScrollY.current;

//       // Scrolling down - hide nav
//       if (diff > SCROLL_THRESHOLD && !isHidden.current && value > 10) {
//         isHidden.current = true;
//         Animated.timing(translateY, {
//           toValue: NAV_HEIGHT + insets.bottom,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }
//       // Scrolling up - show nav
//       else if (diff < -SCROLL_THRESHOLD && isHidden.current) {
//         isHidden.current = false;
//         Animated.timing(translateY, {
//           toValue: 0,
//           duration: 950,
//           easing: Easing.out(Easing.cubic),
//           useNativeDriver: true,
//         }).start();
//       }

//       lastScrollY.current = value;
//     });

//     return () => {
//       scrollY.removeListener(listenerId);
//     };
//   }, [scrollY, translateY, insets.bottom]);

//   const pillOpacity = scrollY
//     ? scrollY.interpolate({
//         inputRange: [0, 150],
//         outputRange: [0.3, 1],
//         extrapolate: 'clamp',
//       })
//     : 1;

//   const styles = StyleSheet.create<{
//     navBar: ViewStyle;
//     glassPill: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 80,
//       backgroundColor: 'transparent',
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//     },
//     glassPill: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '90%',
//       alignSelf: 'center',
//       borderRadius: 50,
//       height: 62,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.muted,
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.2,
//       shadowRadius: 12,
//       shadowOffset: {width: 0, height: 4},
//       backgroundColor: 'transparent',
//       marginBottom: hasHomeButton ? 10 : -14,
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'center',
//       gap: 4,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={styles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <Icon
//         name={icon}
//         size={26}
//         color={isActive ? theme.colors.buttonText1 : theme.colors.buttonText1}
//       />
//       <Text
//         style={[styles.tabLabel, isActive && styles.activeLabel]}
//         numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   return (
//     <Animated.View
//       style={{
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//         transform: [{translateY}],
//       }}>
//       <SafeAreaView
//         edges={['bottom']}
//         style={{
//           backgroundColor: 'transparent',
//         }}>
//         {isLiquidGlassSupported ? (
//           <Animated.View style={{opacity: pillOpacity}}>
//             <LiquidGlassView
//               style={styles.glassPill}
//               effect="clear"
//               tintColor="rgba(0, 0, 0, 0.42)"
//               colorScheme="system">
//               <TabButton
//                 icon="home"
//                 label="Home"
//                 onPress={() => current !== 'Home' && navigate('Home')}
//                 isActive={current === 'Home'}
//               />
//               <TabButton
//                 icon="explore"
//                 label="Fashion"
//                 onPress={() => current !== 'Explore' && navigate('Explore')}
//                 isActive={current === 'Explore'}
//               />
//               <TabButton
//                 icon="auto-awesome"
//                 label="Style Me"
//                 onPress={() => current !== 'Outfit' && navigate('Outfit')}
//                 isActive={current === 'Outfit'}
//               />
//               <TabButton
//                 icon="style"
//                 label="Wardrobe"
//                 onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//                 isActive={current === 'Wardrobe'}
//               />
//               <TabButton
//                 icon="checkroom"
//                 label="Saved"
//                 onPress={() =>
//                   current !== 'SavedOutfits' && navigate('SavedOutfits')
//                 }
//                 isActive={current === 'SavedOutfits'}
//               />
//             </LiquidGlassView>
//           </Animated.View>
//         ) : (
//           // fallback if LiquidGlass unsupported
//           <View
//             style={[
//               styles.glassPill,
//               {backgroundColor: 'rgba(0, 0, 0, 0.44)'},
//             ]}>
//             <TabButton
//               icon="home"
//               label="Home"
//               onPress={() => current !== 'Home' && navigate('Home')}
//               isActive={current === 'Home'}
//             />
//             <TabButton
//               icon="explore"
//               label="Fashion"
//               onPress={() => current !== 'Explore' && navigate('Explore')}
//               isActive={current === 'Explore'}
//             />
//             <TabButton
//               icon="auto-awesome"
//               label="Style Me"
//               onPress={() => current !== 'Outfit' && navigate('Outfit')}
//               isActive={current === 'Outfit'}
//             />
//             <TabButton
//               icon="style"
//               label="Wardrobe"
//               onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//               isActive={current === 'Wardrobe'}
//             />
//             <TabButton
//               icon="checkroom"
//               label="Saved"
//               onPress={() =>
//                 current !== 'SavedOutfits' && navigate('SavedOutfits')
//               }
//               isActive={current === 'SavedOutfits'}
//             />
//           </View>
//         )}
//       </SafeAreaView>
//     </Animated.View>
//   );
// };

// export default BottomNavigation;

///////////////////

// import React from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import { SafeAreaView } from 'react-native-safe-area-context';
// import { LiquidGlassView, isLiquidGlassSupported } from '@callstack/liquid-glass';
// import { useAppTheme } from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import { fontScale } from '../../utils/scale';
// import { tokens } from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// const BottomNavigation = ({ current, navigate, scrollY }: Props) => {
//   const { theme } = useAppTheme();

//   const pillOpacity = scrollY
//     ? scrollY.interpolate({
//         inputRange: [0, 150],
//         outputRange: [0.3, 1],
//         extrapolate: 'clamp',
//       })
//     : 1;

//   const styles = StyleSheet.create<{
//     navBar: ViewStyle;
//     glassWrapper: ViewStyle;
//     glassPill: ViewStyle;
//     innerHighlight: ViewStyle;
//     edgeGlow: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 80,
//       backgroundColor: 'transparent',
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//     },
//     glassWrapper: {
//       width: '90%',
//       alignSelf: 'center',
//       height: 62,
//       marginBottom: -14,
//       position: 'relative',
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 20,
//       shadowOffset: { width: 0, height: 8 },
//     },
//     glassPill: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       borderRadius: 50,
//       height: '100%',
//       overflow: 'hidden',
//       backgroundColor: 'transparent',
//       borderWidth: tokens.borderWidth.sm,
//       borderColor: 'rgba(255,255,255,0.25)',
//     },
//     innerHighlight: {
//       ...StyleSheet.absoluteFillObject,
//       borderRadius: 50,
//       borderWidth: 1,
//       borderColor: 'rgba(255,255,255,0.35)',
//       backgroundColor: 'rgba(255,255,255,0.06)',
//     },
//     edgeGlow: {
//       ...StyleSheet.absoluteFillObject,
//       borderRadius: 50,
//       borderWidth: 2,
//       borderColor: 'rgba(255,255,255,0.2)',
//       shadowColor: '#66ccff',
//       shadowOpacity: 0.25,
//       shadowRadius: 18,
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'center',
//       gap: 4,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '500',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.buttonText1,
//       fontWeight: '600',
//     },
//   });

//   const TabButton = ({ icon, label, onPress, isActive }: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={styles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <Icon
//         name={icon}
//         size={26}
//         color={isActive ? theme.colors.buttonText1 : theme.colors.buttonText1}
//       />
//       <Text style={[styles.tabLabel, isActive && styles.activeLabel]} numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   const GlassContent = (
//     <>
//       <TabButton
//         icon="home"
//         label="Home"
//         onPress={() => current !== 'Home' && navigate('Home')}
//         isActive={current === 'Home'}
//       />
//       <TabButton
//         icon="explore"
//         label="Fashion"
//         onPress={() => current !== 'Explore' && navigate('Explore')}
//         isActive={current === 'Explore'}
//       />
//       <TabButton
//         icon="auto-awesome"
//         label="Style Me"
//         onPress={() => current !== 'Outfit' && navigate('Outfit')}
//         isActive={current === 'Outfit'}
//       />
//       <TabButton
//         icon="style"
//         label="Wardrobe"
//         onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//         isActive={current === 'Wardrobe'}
//       />
//       <TabButton
//         icon="checkroom"
//         label="Saved"
//         onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//         isActive={current === 'SavedOutfits'}
//       />
//     </>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{
//         backgroundColor: 'transparent',
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//       }}>
//       {isLiquidGlassSupported ? (
//         <Animated.View style={{ opacity: pillOpacity }}>
//           <View style={styles.glassWrapper}>
//             {/* Back layer for refractive depth */}
//             <LiquidGlassView
//               style={[styles.glassPill, { opacity: 0.55 }]}
//               effect="clear"
//               tintColor="rgba(255,255,255,0.35)"
//               colorScheme="system"
//             />

//             {/* Foreground layer for clarity + highlights */}
//             <LiquidGlassView
//               style={[styles.glassPill, { position: 'absolute', opacity: 0.95 }]}
//               effect="clear"
//               tintColor="rgba(255,255,255,0.25)"
//               colorScheme="system"
//             >
//               {GlassContent}
//             </LiquidGlassView>

//             {/* Edge lighting and depth overlays */}
//             <View style={styles.innerHighlight} pointerEvents="none" />
//             <View style={styles.edgeGlow} pointerEvents="none" />
//           </View>
//         </Animated.View>
//       ) : (
//         // fallback if LiquidGlass unsupported
//         <View style={[styles.glassPill, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
//           {GlassContent}
//         </View>
//       )}
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

// ///////////////////

// import React from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
// };

// const BottomNavigation = ({current, navigate, scrollY}: Props) => {
//   const {theme} = useAppTheme();

//   const navStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//     glassIcon: ViewStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 84,
//       backgroundColor: 'transparent',
//       paddingBottom: Platform.OS === 'ios' ? 10 : 6,
//       position: 'absolute',
//       bottom: 0,
//       left: 0,
//       right: 0,
//       zIndex: 999,
//     },
//     glassIcon: {
//       width: 64,
//       height: 64,
//       borderRadius: 32,
//       alignItems: 'center',
//       justifyContent: 'center',
//       borderWidth: 0.8,
//       borderColor: 'rgba(255,255,255,0.25)',
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.2,
//       shadowRadius: 8,
//       shadowOffset: {width: 0, height: 2},
//     },
//     tabButton: {
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       gap: 6,
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.foreground2,
//       fontWeight: '300',
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.primary,
//       fontWeight: '500',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={navStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       {isLiquidGlassSupported ? (
//         <LiquidGlassView
//           style={[
//             navStyles.glassIcon,
//             {tintColor: 'rgba(255,255,255,0.15)', effect: 'clear'},
//           ]}
//           interactive
//           effect="clear"
//           tintColor="rgba(255,255,255,0.25)"
//           colorScheme="system">
//           <Icon
//             name={icon}
//             size={28}
//             color={isActive ? theme.colors.primary : theme.colors.foreground}
//           />
//         </LiquidGlassView>
//       ) : (
//         <View
//           style={[
//             navStyles.glassIcon,
//             {backgroundColor: 'rgba(255,255,255,0.1)'},
//           ]}>
//           <Icon
//             name={icon}
//             size={28}
//             color={isActive ? theme.colors.primary : theme.colors.foreground}
//           />
//         </View>
//       )}
//       <Text
//         style={[navStyles.tabLabel, isActive && navStyles.activeLabel]}
//         numberOfLines={1}>
//         {label}
//       </Text>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{
//         backgroundColor: 'transparent',
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//       }}>
//       <View style={navStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />
//         <TabButton
//           icon="explore"
//           label="Fashion"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />
//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />
//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />
//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

/////////////////////////

// import React from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
//   enableBlur?: boolean;
// };

// const BottomNavigation = ({
//   current,
//   navigate,
//   scrollY,
//   enableBlur = true,
// }: Props) => {
//   const {theme} = useAppTheme();

//   // 🔹 Optional dynamic fade on scroll
//   const blurOpacity = scrollY
//     ? scrollY.interpolate({
//         inputRange: [0, 150],
//         outputRange: [0.2, 1],
//         extrapolate: 'clamp',
//       })
//     : 1;

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//     glassWrapper: ViewStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 58,
//       backgroundColor: 'transparent',
//       borderTopWidth: 0.4,
//       borderTopColor: 'rgba(255,255,255,0.12)',
//       paddingBottom: Platform.OS === 'ios' ? 8 : 4,
//       zIndex: 999,
//     },
//     tabButton: {
//       width: 72,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: moderateScale(tokens.spacing.xxs),
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.foreground2,
//       fontWeight: '300',
//       marginTop: 2,
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.primary,
//       fontWeight: '500',
//     },
//     glassWrapper: {
//       ...StyleSheet.absoluteFillObject,
//       overflow: 'hidden',
//       borderTopWidth: 0.3,
//       borderColor: 'rgba(255,255,255,0.15)',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{
//         backgroundColor: 'transparent',
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//       }}>
//       {/* 🧊 Liquid Glass Layer */}
//       {enableBlur && (
//         <Animated.View
//           style={[themedStyles.glassWrapper, {opacity: blurOpacity}]}
//           pointerEvents="none">
//           {isLiquidGlassSupported ? (
//             <LiquidGlassView
//               style={StyleSheet.absoluteFill}
//               interactive
//               effect="clear"
//               tintColor="rgba(255,255,255,0.25)"
//               colorScheme="system"
//             />
//           ) : (
//             // fallback for unsupported devices
//             <View
//               style={{
//                 ...StyleSheet.absoluteFillObject,
//                 backgroundColor: 'rgba(255,255,255,0.15)',
//               }}
//             />
//           )}
//         </Animated.View>
//       )}

//       {/* 🔹 Nav Content */}
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />

//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />

//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />

//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

/////////////////////

// import React from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ViewStyle,
//   TextStyle,
//   Platform,
//   Animated,
// } from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {BlurView} from '@react-native-community/blur';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// type Props = {
//   current: string;
//   navigate: (screen: string) => void;
//   scrollY?: Animated.Value;
//   enableBlur?: boolean;
// };

// const BottomNavigation = ({
//   current,
//   navigate,
//   scrollY,
//   enableBlur = true,
// }: Props) => {
//   const {theme} = useAppTheme();

//   // 🔹 Apple-style dynamic fade (based on scroll, optional)
//   const blurOpacity = scrollY
//     ? scrollY.interpolate({
//         inputRange: [0, 150],
//         outputRange: [0.2, 1],
//         extrapolate: 'clamp',
//       })
//     : 1;

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//     blurWrapper: ViewStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       height: 50,
//       backgroundColor: 'transparent',
//       borderTopWidth: 0.4,
//       borderTopColor: 'rgba(255,255,255,0.12)',
//       paddingBottom: Platform.OS === 'ios' ? 8 : 4,
//       zIndex: 999,
//     },
//     tabButton: {
//       width: 72,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: moderateScale(tokens.spacing.xxs),
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.foreground2,
//       fontWeight: '300',
//       marginTop: 2,
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.primary,
//       fontWeight: '500',
//     },
//     blurWrapper: {
//       ...StyleSheet.absoluteFillObject,
//       overflow: 'hidden',
//       borderTopWidth: 0.3,
//       borderColor: 'rgba(255,255,255,0.15)',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{
//         backgroundColor: 'transparent',
//         position: 'absolute',
//         bottom: 0,
//         left: 0,
//         right: 0,
//         zIndex: 999,
//       }}>
//       {/* 🔹 Optional Frosted Glass Layer */}
//       {enableBlur && (
//         <Animated.View
//           style={[themedStyles.blurWrapper, {opacity: blurOpacity}]}
//           pointerEvents="none">
//           <BlurView
//             style={StyleSheet.absoluteFill}
//             // blurType={Platform.OS === 'ios' ? 'light' : 'dark'}
//             blurAmount={25}
//             reducedTransparencyFallbackColor="rgba(255,255,255,0.08)"
//           />
//         </Animated.View>
//       )}

//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />

//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />

//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />

//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

////////////////////

// import React from 'react';
// import {View, Text, StyleSheet, ViewStyle, TextStyle} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// const BottomNavigation = ({
//   current,
//   navigate,
// }: {
//   current: string;
//   navigate: (screen: string) => void;
// }) => {
//   const {theme} = useAppTheme();

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       backgroundColor: theme.colors.background,
//       borderTopWidth: 1,
//       borderTopColor: theme.colors.surfaceBorder,
//       height: 47,
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//       // paddingHorizontal: moderateScale(tokens.spacing.md1),
//     },
//     tabButton: {
//       width: 72,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: moderateScale(tokens.spacing.xxs),
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.foreground,
//       fontWeight: '300',
//       marginTop: 2,
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.primary,
//       fontWeight: '400',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{backgroundColor: theme.colors.background}}>
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />

//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />

//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />

//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

/////////////////////

// import React from 'react';
// import {View, Text, StyleSheet, ViewStyle, TextStyle} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {fontScale, moderateScale} from '../../utils/scale';
// import {tokens} from '../../styles/tokens/tokens';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// const BottomNavigation = ({
//   current,
//   navigate,
// }: {
//   current: string;
//   navigate: (screen: string) => void;
// }) => {
//   const {theme} = useAppTheme();

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       backgroundColor: theme.colors.background,
//       borderTopWidth: 1,
//       borderTopColor: theme.colors.surfaceBorder,
//       height: 47,
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//     },
//     tabButton: {
//       width: 72,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: moderateScale(tokens.spacing.xxs),
//     },
//     tabLabel: {
//       fontSize: fontScale(tokens.fontSize.xxxs),
//       color: theme.colors.foreground,
//       fontWeight: '300',
//       marginTop: 0,
//     },
//     activeLabel: {
//       fontSize: fontScale(tokens.fontSize.xxs),
//       color: theme.colors.primary,
//       fontWeight: '400',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{backgroundColor: theme.colors.background}}>
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />

//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />

//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />

//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

/////////////////////////

// import React from 'react';
// import {View, Text, StyleSheet, ViewStyle, TextStyle} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// const BottomNavigation = ({
//   current,
//   navigate,
// }: {
//   current: string;
//   navigate: (screen: string) => void;
// }) => {
//   const {theme} = useAppTheme();

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       backgroundColor: theme.colors.background,
//       borderTopWidth: 1,
//       borderTopColor: theme.colors.surfaceBorder,
//       height: 47,
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//     },
//     tabButton: {
//       width: 72,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: 6,
//     },
//     tabLabel: {
//       fontSize: 9,
//       color: theme.colors.foreground,
//       fontWeight: '300',
//       marginTop: 0,
//     },
//     activeLabel: {
//       fontSize: 10,
//       color: theme.colors.primary,
//       fontWeight: '400',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{backgroundColor: theme.colors.background}}>
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />

//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />

//         <TabButton
//           icon="qr-code-scanner"
//           label="Barcode"
//           onPress={() =>
//             current !== 'BarcodeScannerScreen' &&
//             navigate('BarcodeScannerScreen')
//           }
//           isActive={current === 'BarcodeScannerScreen'}
//         />

//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />

//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

/////////////////

// import React from 'react';
// import {View, Text, StyleSheet, ViewStyle, TextStyle} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// const BottomNavigation = ({
//   current,
//   navigate,
// }: {
//   current: string;
//   navigate: (screen: string) => void;
// }) => {
//   const {theme} = useAppTheme();

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       backgroundColor: theme.colors.background,
//       borderTopWidth: 1,
//       borderTopColor: theme.colors.surfaceBorder,
//       height: 47,
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//     },
//     tabButton: {
//       width: 90,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: 6,
//     },
//     tabLabel: {
//       fontSize: 9,
//       color: theme.colors.foreground,
//       fontWeight: '300',
//       marginTop: 0,
//     },
//     activeLabel: {
//       fontSize: 10,
//       color: theme.colors.primary,
//       fontWeight: '400',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       // Only buzz when changing tabs; no haptic on active tab
//       hapticStyle={isActive ? undefined : 'impactLight'}
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={26}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{backgroundColor: theme.colors.background}}>
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => current !== 'Home' && navigate('Home')}
//           isActive={current === 'Home'}
//         />
//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => current !== 'Explore' && navigate('Explore')}
//           isActive={current === 'Explore'}
//         />
//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => current !== 'Outfit' && navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />
//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => current !== 'Wardrobe' && navigate('Wardrobe')}
//           isActive={current === 'Wardrobe'}
//         />
//         <TabButton
//           icon="checkroom"
//           label="Saved Outfits"
//           onPress={() => current !== 'SavedOutfits' && navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;

//////////////////////////

// import React from 'react';
// import {View, Text, StyleSheet, ViewStyle, TextStyle} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

// interface TabButtonProps {
//   icon: string;
//   label: string;
//   onPress: () => void;
//   isActive?: boolean;
// }

// const BottomNavigation = ({
//   current,
//   navigate,
// }: {
//   current: string;
//   navigate: (screen: string) => void;
// }) => {
//   const {theme} = useAppTheme();

//   const themedStyles = StyleSheet.create<{
//     navBar: ViewStyle;
//     tabButton: ViewStyle;
//     tabLabel: TextStyle;
//     activeLabel: TextStyle;
//   }>({
//     navBar: {
//       flexDirection: 'row',
//       backgroundColor: theme.colors.background,
//       borderTopWidth: 1,
//       borderTopColor: theme.colors.surfaceBorder,
//       height: 47,
//       justifyContent: 'space-around',
//       alignItems: 'center',
//       width: '100%',
//     },
//     tabButton: {
//       width: 90,
//       height: 42,
//       alignItems: 'center',
//       justifyContent: 'flex-start',
//       paddingTop: 6,
//     },
//     tabLabel: {
//       fontSize: 9,
//       color: theme.colors.foreground,
//       fontWeight: '300',
//       marginTop: 0,
//     },
//     activeLabel: {
//       fontSize: 10,
//       color: theme.colors.primary,
//       fontWeight: '400',
//     },
//   });

//   const TabButton = ({icon, label, onPress, isActive}: TabButtonProps) => (
//     <AppleTouchFeedback
//       style={themedStyles.tabButton}
//       hapticStyle="impactLight"
//       onPress={onPress}>
//       <>
//         <Icon
//           name={icon}
//           size={icon === 'home' ? 26 : 26}
//           // style={{marginTop: -32}}
//           color={isActive ? theme.colors.primary : theme.colors.foreground2}
//         />
//         <Text
//           style={[themedStyles.tabLabel, isActive && themedStyles.activeLabel]}>
//           {label}
//         </Text>
//       </>
//     </AppleTouchFeedback>
//   );

//   return (
//     <SafeAreaView
//       edges={['bottom']}
//       style={{backgroundColor: theme.colors.background}}>
//       <View style={themedStyles.navBar}>
//         <TabButton
//           icon="home"
//           label="Home"
//           onPress={() => navigate('Home')}
//           isActive={current === 'Home'}
//         />
//         <TabButton
//           icon="explore"
//           label="Fashion News"
//           onPress={() => navigate('Explore')}
//           isActive={current === 'Explore'}
//         />
//         <TabButton
//           icon="auto-awesome"
//           label="Style Me"
//           onPress={() => navigate('Outfit')}
//           isActive={current === 'Outfit'}
//         />
//         <TabButton
//           icon="style"
//           label="Wardrobe"
//           onPress={() => navigate('Wardrobe')}
//           isActive={current === 'Closet'}
//         />

//         <TabButton
//           icon="checkroom"
//           label="Saved Outfits"
//           onPress={() => navigate('SavedOutfits')}
//           isActive={current === 'SavedOutfits'}
//         />
//       </View>
//     </SafeAreaView>
//   );
// };

// export default BottomNavigation;
