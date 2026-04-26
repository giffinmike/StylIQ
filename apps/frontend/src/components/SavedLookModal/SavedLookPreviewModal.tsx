import React, {useState, useEffect, useRef} from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  Dimensions,
  Platform,
  Animated,
  PanResponder,
  TouchableOpacity,
} from 'react-native';
import {BlurView} from '@react-native-community/blur';
import {useAppTheme} from '../../context/ThemeContext';
import {useUUID} from '../../context/UUIDContext';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
import {useDeleteSavedLook, useRenameSavedLook} from '../../hooks/useHomeData';
import * as Animatable from 'react-native-animatable';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {SafeAreaView} from 'react-native-safe-area-context';
import {tokens} from '../../styles/tokens/tokens';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

const {height, width} = Dimensions.get('window');

type Props = {
  visible: boolean;
  onClose: () => void;
  look: {id: string; name: string; image_url: string} | null;
};

export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
  const {theme} = useAppTheme();
  const userId = useUUID();
  const [newName, setNewName] = useState('');

  // TanStack Query mutations from shared hooks
  const deleteSavedLookMutation = useDeleteSavedLook();
  const renameSavedLookMutation = useRenameSavedLook();
  const translateY = useRef(new Animated.Value(0)).current;
  const globalStyles = useGlobalStyles();
  const insets = useSafeAreaInsets();

  const styles = StyleSheet.create({
    modalContainer: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
    },
    panel: {
      flex: 1,
      backgroundColor: theme.colors.background,
      shadowColor: '#000',
      shadowOpacity: 0.5,
      shadowRadius: 24,
      shadowOffset: {width: 0, height: -8},
      elevation: 20,
    },

    // —— Controls identical layering to ReaderModal ——
    closeIcon: {
      position: 'absolute',
      top: 0, // sits ABOVE gesture zone
      right: 20,
      zIndex: 20,
      borderRadius: 50,
      borderColor: 'black',
      borderWidth: tokens.borderWidth.hairline,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    gestureZone: {
      position: 'absolute',
      top: 46,
      height: 110,
      width: '100%',
      zIndex: 999, // ⬅️ crucial
      // backgroundColor: 'rgba(255, 0, 0, 0.4)',
    },

    // —— Content ——
    heroImage: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    },
    nameContainer: {
      position: 'absolute',
      bottom: height * 0.28,
      alignSelf: 'center',
      width: '85%',
    },
    nameInput: {
      fontSize: 22,
      fontWeight: '700',
      color: '#fff',
      textAlign: 'center',
      backgroundColor: 'rgba(0,0,0,0.45)',
      paddingVertical: 10,
      borderRadius: 14,
    },
    bottomSheet: {
      position: 'absolute',
      bottom: insets.bottom > 0 ? insets.bottom - 80 : 0, // ✅ lift above home bar
      width: '100%',
      paddingBottom: insets.bottom + 16, // ✅ adds breathing room
      paddingTop: 20,
      paddingHorizontal: 20,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      backgroundColor:
        Platform.OS === 'android' ? 'rgba(20,20,20,0.8)' : 'transparent',
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 30,
    },
    url: {
      color: 'rgba(255,255,255,0.7)',
      fontSize: 13,
      textAlign: 'center',
      marginBottom: 20,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'space-around',
    },
    actionText: {
      color: '#fff',
      fontWeight: '700',
      fontSize: 17,
      letterSpacing: 0.3,
    },
  });

  useEffect(() => {
    if (look) setNewName(look.name || '');
    if (visible) translateY.setValue(0);
  }, [look, visible, translateY]);

  const handleClose = () => {
    Animated.timing(translateY, {
      toValue: height,
      duration: 220,
      useNativeDriver: true,
    }).start(({finished}) => {
      if (finished) {
        onClose();
        // Reset after modal is closed
        setTimeout(() => {
          translateY.setValue(0);
        }, 100);
      }
    });
  };

  // PanResponder (same thresholds as ReaderModal)
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

  // Handle delete using shared mutation
  const handleDelete = () => {
    if (!look?.id || !userId) return;
    deleteSavedLookMutation.mutate(
      {userId, lookId: look.id},
      {
        onSuccess: () => onClose(),
        onError: (err: any) => {
          Alert.alert('Error', err?.message || 'Could not delete the saved look.');
        },
      },
    );
  };

  // Handle rename using shared mutation
  const handleRename = () => {
    if (!look?.id || !userId || !newName.trim()) return;
    renameSavedLookMutation.mutate(
      {userId, lookId: look.id, name: newName.trim()},
      {
        onSuccess: () => {
          Alert.alert('✅ Updated', 'Look name updated successfully.');
          onClose();
        },
        onError: (err: any) => {
          Alert.alert('Error', err?.message || 'Could not update the saved look.');
        },
      },
    );
  };

  if (!look) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleClose}>
      <SafeAreaView style={styles.modalContainer}>
        {/* Backdrop (same as ReaderModal) */}
        <View style={[styles.backdrop, {backgroundColor: '#000'}]} />

        {/* Animated panel (same structure as ReaderModal) */}
        <Animated.View
          style={[
            styles.panel,
            {
              transform: [{translateY}],
              width: '100%',
              height: '100%', 
            },
          ]}>
          {/* Close button ABOVE gesture zone */}
          <TouchableOpacity
            style={[
              styles.closeIcon,
              {marginTop: 14, backgroundColor: 'white'},
            ]}
            onPress={handleClose}
            hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
            <Text
              style={{
                color: 'black',
                fontSize: 22,
                fontWeight: '900',
              }}>
              ✕
            </Text>
          </TouchableOpacity>

          {/* Swipe gesture zone (TOP) */}
          <View
            {...panResponder.panHandlers}
            style={styles.gestureZone}
            onStartShouldSetResponder={() => true}
          />

          {/* Full-bleed hero image */}
          <Animatable.Image
            source={{uri: look.image_url}}
            resizeMode="contain"
            animation="zoomIn"
            duration={500}
            style={styles.heroImage}
          />

          {/* Floating Name Input */}
          <Animatable.View
            animation="fadeInUp"
            delay={250}
            style={styles.nameContainer}>
            <TextInput
              style={styles.nameInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="Enter look name"
              placeholderTextColor="rgba(255,255,255,0.6)"
            />
          </Animatable.View>

          {/* Frosted Bottom Panel */}
          <Animatable.View
            animation="fadeInUp"
            delay={350}
            style={styles.bottomSheet}>
            {Platform.OS === 'ios' && (
              <BlurView
                style={StyleSheet.absoluteFill}
                blurType="systemUltraThinMaterialDark"
                blurAmount={30}
              />
            )}

            <Text style={styles.url} numberOfLines={1}>
              {look.image_url}
            </Text>

            <View style={styles.actions}>
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={handleRename}
                style={[globalStyles.buttonPrimary, {paddingHorizontal: 32}]}>
                <Text style={styles.actionText}>
                  {renameSavedLookMutation.isPending ? 'Saving…' : 'Save'}
                </Text>
              </AppleTouchFeedback>

              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={handleDelete}
                style={[
                  globalStyles.buttonPrimary,
                  {paddingHorizontal: 32, backgroundColor: theme.colors.error},
                ]}>
                <Text style={styles.actionText}>
                  {deleteSavedLookMutation.isPending ? 'Deleting…' : 'Delete'}
                </Text>
              </AppleTouchFeedback>
            </View>
          </Animatable.View>
        </Animated.View>
      </SafeAreaView>
    </Modal>
  );
}

////////////////

// import React, {useState, useEffect, useRef} from 'react';
// import {
//   Modal,
//   View,
//   Text,
//   TextInput,
//   StyleSheet,
//   Alert,
//   Dimensions,
//   Platform,
//   Animated,
//   PanResponder,
//   TouchableOpacity,
//   SafeAreaView,
// } from 'react-native';
// import {BlurView} from '@react-native-community/blur';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';

// const {height, width} = Dimensions.get('window');

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const queryClient = useQueryClient();
//   const [newName, setNewName] = useState('');
//   const translateY = useRef(new Animated.Value(0)).current;
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     modalContainer: {
//       flex: 1,
//       backgroundColor: 'transparent',
//     },
//     backdrop: {
//       ...StyleSheet.absoluteFillObject,
//     },
//     panel: {
//       flex: 1,
//       backgroundColor: '#000', // keep black behind the image
//       shadowColor: '#000',
//       shadowOpacity: 0.5,
//       shadowRadius: 24,
//       shadowOffset: {width: 0, height: -8},
//       elevation: 20,
//     },

//     // —— Controls identical layering to ReaderModal ——
//     closeIcon: {
//       position: 'absolute',
//       top: 0, // sits ABOVE gesture zone
//       right: 20,
//       zIndex: 20,
//       backgroundColor: theme.colors.background,
//       borderRadius: 50,
//       paddingHorizontal: 8,
//       paddingVertical: 6,
//     },
//     gestureZone: {
//       position: 'absolute',
//       top: 28,
//       height: 110,
//       width: '100%',
//       zIndex: 999, // ⬅️ crucial
//       // backgroundColor: 'rgba(255, 0, 0, 0.4)',
//     },

//     // —— Content ——
//     heroImage: {
//       width,
//       height,
//       position: 'absolute',
//       top: 0,
//       left: 0,
//     },
//     nameContainer: {
//       position: 'absolute',
//       bottom: height * 0.28,
//       alignSelf: 'center',
//       width: '85%',
//     },
//     nameInput: {
//       fontSize: 22,
//       fontWeight: '700',
//       color: '#fff',
//       textAlign: 'center',
//       backgroundColor: 'rgba(0,0,0,0.45)',
//       paddingVertical: 10,
//       borderRadius: 14,
//     },
//     bottomSheet: {
//       position: 'absolute',
//       bottom: -35,
//       width: '100%',
//       paddingBottom: 36,
//       paddingTop: 20,
//       paddingHorizontal: 20,
//       borderTopLeftRadius: 26,
//       borderTopRightRadius: 26,
//       backgroundColor:
//         Platform.OS === 'android' ? 'rgba(20,20,20,0.8)' : 'transparent',
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 30,
//     },
//     url: {
//       color: 'rgba(255,255,255,0.7)',
//       fontSize: 13,
//       textAlign: 'center',
//       marginBottom: 20,
//     },
//     actions: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//     },
//     actionText: {
//       color: '#fff',
//       fontWeight: '700',
//       fontSize: 17,
//       letterSpacing: 0.3,
//     },
//   });

//   useEffect(() => {
//     if (look) setNewName(look.name || '');
//     if (visible) translateY.setValue(0);
//   }, [look, visible, translateY]);

//   const handleClose = () => {
//     Animated.timing(translateY, {
//       toValue: height,
//       duration: 220,
//       useNativeDriver: true,
//     }).start(({finished}) => {
//       if (finished) {
//         translateY.setValue(0);
//         onClose();
//       }
//     });
//   };

//   // PanResponder (same thresholds as ReaderModal)
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

//   // Delete
//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to delete saved look');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not delete the saved look.');
//     },
//   });

//   // Update
//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       if (!look?.id) throw new Error('Missing look ID');
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${look.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({name: newName}),
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to update look name');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       Alert.alert('✅ Updated', 'Look name updated successfully.');
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not update the saved look.');
//     },
//   });

//   if (!look) return null;

//   return (
//     <Modal
//       visible={visible}
//       transparent
//       animationType="fade"
//       onRequestClose={handleClose}>
//       <SafeAreaView style={styles.modalContainer}>
//         {/* Backdrop (same as ReaderModal) */}
//         <Animatable.View
//           animation="fadeIn"
//           duration={300}
//           style={[styles.backdrop, {backgroundColor: '#000'}]}
//         />

//         {/* Animated panel (same structure as ReaderModal) */}
//         <Animated.View
//           style={[
//             styles.panel,
//             {
//               transform: [{translateY}],
//               width: '100%',
//               height: '100%', // 👈 ensures full height
//             },
//           ]}>
//           {/* Close button ABOVE gesture zone */}
//           <TouchableOpacity
//             style={[
//               styles.closeIcon,
//               {backgroundColor: theme.colors.foreground, marginTop: 4},
//             ]}
//             onPress={handleClose}
//             hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
//             <Text
//               style={{
//                 color: theme.colors.background,
//                 fontSize: 18,
//                 fontWeight: '900',
//               }}>
//               ✕
//             </Text>
//           </TouchableOpacity>

//           {/* Swipe gesture zone (TOP) */}
//           <View
//             {...panResponder.panHandlers}
//             style={styles.gestureZone}
//             onStartShouldSetResponder={() => true}
//           />

//           {/* Full-bleed hero image */}
//           <Animatable.Image
//             source={{uri: look.image_url}}
//             resizeMode="cover"
//             animation="zoomIn"
//             duration={500}
//             style={styles.heroImage}
//           />

//           {/* Floating Name Input */}
//           <Animatable.View
//             animation="fadeInUp"
//             delay={250}
//             style={styles.nameContainer}>
//             <TextInput
//               style={styles.nameInput}
//               value={newName}
//               onChangeText={setNewName}
//               placeholder="Enter look name"
//               placeholderTextColor="rgba(255,255,255,0.6)"
//             />
//           </Animatable.View>

//           {/* Frosted Bottom Panel */}
//           <Animatable.View
//             animation="fadeInUp"
//             delay={350}
//             style={styles.bottomSheet}>
//             {Platform.OS === 'ios' && (
//               <BlurView
//                 style={StyleSheet.absoluteFill}
//                 blurType="systemUltraThinMaterialDark"
//                 blurAmount={30}
//               />
//             )}

//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             <View style={styles.actions}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => updateMutation.mutate()}
//                 style={[globalStyles.buttonPrimary, {paddingHorizontal: 32}]}>
//                 <Text style={styles.actionText}>
//                   {updateMutation.isLoading ? 'Saving…' : 'Save'}
//                 </Text>
//               </AppleTouchFeedback>

//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => deleteMutation.mutate(look.id)}
//                 style={[
//                   globalStyles.buttonPrimary,
//                   {paddingHorizontal: 32, backgroundColor: theme.colors.error},
//                 ]}>
//                 <Text style={styles.actionText}>
//                   {deleteMutation.isLoading ? 'Deleting…' : 'Delete'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </Animatable.View>
//         </Animated.View>
//       </SafeAreaView>
//     </Modal>
//   );
// }

///////////////

// import React, {useState, useEffect} from 'react';
// import {
//   Modal,
//   View,
//   Image,
//   Text,
//   TextInput,
//   StyleSheet,
//   Alert,
//   Dimensions,
//   Platform,
// } from 'react-native';
// import {BlurView} from '@react-native-community/blur';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';
// import * as Animatable from 'react-native-animatable';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';

// const {height, width} = Dimensions.get('window');

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const queryClient = useQueryClient();
//   const [newName, setNewName] = useState('');
//   const globalStyles = useGlobalStyles();

//   // const {height, width} = Dimensions.get('window');

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: '#000',
//       justifyContent: 'flex-start',
//       alignItems: 'center',
//     },
//     heroImage: {
//       width: width,
//       height: height,
//       position: 'absolute',
//       top: 0,
//       left: 0,
//     },
//     topBar: {
//       width: '100%',
//       paddingTop: 60,
//       paddingHorizontal: 24,
//       position: 'absolute',
//       top: 0,
//       zIndex: 10,
//       flexDirection: 'row',
//       justifyContent: 'flex-end',
//     },
//     closeButton: {
//       backgroundColor: 'rgba(0,0,0,0.4)',
//       paddingVertical: 6,
//       paddingHorizontal: 14,
//       borderRadius: 30,
//     },
//     closeText: {
//       color: '#fff',
//       fontSize: 20,
//       fontWeight: '600',
//     },
//     nameContainer: {
//       position: 'absolute',
//       bottom: height * 0.28,
//       alignSelf: 'center',
//       width: '85%',
//     },
//     nameInput: {
//       fontSize: 22,
//       fontWeight: '700',
//       color: '#fff',
//       textAlign: 'center',
//       backgroundColor: 'rgba(0,0,0,0.45)',
//       paddingVertical: 10,
//       borderRadius: 14,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowRadius: 12,
//     },
//     bottomSheet: {
//       position: 'absolute',
//       bottom: 0,
//       width: '100%',
//       paddingBottom: 36,
//       paddingTop: 20,
//       paddingHorizontal: 20,
//       borderTopLeftRadius: 26,
//       borderTopRightRadius: 26,
//       backgroundColor:
//         Platform.OS === 'android' ? 'rgba(20,20,20,0.8)' : 'transparent',
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 30,
//     },
//     url: {
//       color: 'rgba(255,255,255,0.7)',
//       fontSize: 13,
//       textAlign: 'center',
//       marginBottom: 20,
//     },
//     actions: {
//       flexDirection: 'row',
//       justifyContent: 'space-around',
//     },
//     actionButton: {
//       flex: 1,
//       marginHorizontal: 10,
//       paddingVertical: 14,
//       borderRadius: 30,
//       alignItems: 'center',
//       shadowColor: '#000',
//       shadowOpacity: 0.3,
//       shadowRadius: 10,
//     },
//     saveButton: {
//       marginTop: 12,
//       backgroundColor: theme.colors.button1 || '#a704ffff',
//     },
//     deleteButton: {
//       marginTop: 16,
//       backgroundColor: theme.colors.surface3 || '#D32F2F',
//     },
//     actionText: {
//       color: '#fff',
//       fontWeight: '700',
//       fontSize: 17,
//       letterSpacing: 0.3,
//     },
//   });

//   useEffect(() => {
//     if (look) setNewName(look.name || '');
//   }, [look]);

//   // 🗑️ Delete
//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to delete saved look');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not delete the saved look.');
//     },
//   });

//   // ✏️ Update
//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       if (!look?.id) throw new Error('Missing look ID');
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${look.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({name: newName}),
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to update look name');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       Alert.alert('✅ Updated', 'Look name updated successfully.');
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not update the saved look.');
//     },
//   });

//   const handleDelete = () => {
//     if (!look?.id) {
//       Alert.alert('Error', 'Look ID is missing — cannot delete.');
//       return;
//     }
//     Alert.alert(
//       'Delete Saved Look',
//       'Are you sure you want to delete this saved look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => deleteMutation.mutate(look.id),
//         },
//       ],
//     );
//   };

//   if (!look) return null;

//   return (
//     <Modal
//       visible={visible}
//       transparent
//       animationType="fade"
//       statusBarTranslucent>
//       <Animatable.View animation="fadeIn" duration={300} style={styles.overlay}>
//         {/* Full-bleed hero image */}
//         <Animatable.Image
//           source={{uri: look.image_url}}
//           resizeMode="cover"
//           animation="zoomIn"
//           duration={500}
//           style={styles.heroImage}
//         />

//         {/* Top Close Button */}
//         <View style={styles.topBar}>
//           <AppleTouchFeedback
//             hapticStyle="impactLight"
//             onPress={onClose}
//             style={styles.closeButton}>
//             <Text style={styles.closeText}>✕</Text>
//           </AppleTouchFeedback>
//         </View>

//         {/* Floating Name Input */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={250}
//           style={styles.nameContainer}>
//           <TextInput
//             style={styles.nameInput}
//             value={newName}
//             onChangeText={setNewName}
//             placeholder="Enter look name"
//             placeholderTextColor="rgba(255,255,255,0.6)"
//           />
//         </Animatable.View>

//         {/* Frosted Bottom Control Panel */}
//         <Animatable.View
//           animation="fadeInUp"
//           delay={350}
//           style={styles.bottomSheet}>
//           {Platform.OS === 'ios' && (
//             <BlurView
//               style={StyleSheet.absoluteFill}
//               blurType="systemUltraThinMaterialDark"
//               blurAmount={30}
//             />
//           )}

//           <Text style={styles.url} numberOfLines={1}>
//             {look.image_url}
//           </Text>

//           <View style={styles.actions}>
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => updateMutation.mutate()}
//               style={[globalStyles.buttonPrimary, {paddingHorizontal: 32}]}>
//               <Text style={styles.actionText}>
//                 {updateMutation.isLoading ? 'Saving…' : 'Save'}
//               </Text>
//             </AppleTouchFeedback>

//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={handleDelete}
//               style={[
//                 globalStyles.buttonPrimary,
//                 {paddingHorizontal: 32, backgroundColor: theme.colors.error},
//               ]}>
//               <Text style={styles.actionText}>
//                 {deleteMutation.isLoading ? 'Deleting…' : 'Delete'}
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </Animatable.View>
//       </Animatable.View>
//     </Modal>
//   );
// }

//////////////

// import React, {useState, useEffect} from 'react';
// import {
//   Modal,
//   View,
//   Image,
//   Text,
//   TextInput,
//   StyleSheet,
//   Alert,
// } from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   // ✅ local editable state for name
//   const [newName, setNewName] = useState('');

//   useEffect(() => {
//     if (look) setNewName(look.name || '');
//   }, [look]);

//   // 🗑️ DELETE mutation
//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to delete saved look');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not delete the saved look.');
//     },
//   });

//   // ✏️ UPDATE mutation
//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       if (!look?.id) throw new Error('Missing look ID');
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${look.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({name: newName}),
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok)
//         throw new Error(data?.message || 'Failed to update look name');
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       Alert.alert('✅ Updated', 'Look name updated successfully.');
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert('Error', err?.message || 'Could not update the saved look.');
//     },
//   });

//   const handleDelete = () => {
//     if (!look?.id) {
//       Alert.alert('Error', 'Look ID is missing — cannot delete.');
//       return;
//     }
//     Alert.alert(
//       'Delete Saved Look',
//       'Are you sure you want to delete this saved look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => deleteMutation.mutate(look.id),
//         },
//       ],
//     );
//   };

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     nameInput: {
//       fontSize: 18,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//       paddingVertical: 8,
//       width: '80%',
//       borderWidth: theme.borderWidth.hairline,
//       borderColor: theme.colors.buttonText1,
//       paddingHorizontal: 20,
//       marginBottom: 12,
//       borderRadius: tokens.borderRadius.sm,
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     saveButton: {
//       marginTop: 12,
//       backgroundColor: theme.colors.button1 || '#a704ffff',
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     deleteButton: {
//       marginTop: 16,
//       backgroundColor: theme.colors.error || '#D32F2F',
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />

//             {/* ✏️ Editable name field */}
//             <TextInput
//               style={[styles.nameInput]}
//               value={newName}
//               onChangeText={setNewName}
//               placeholder="Enter look name"
//               placeholderTextColor={theme.colors.foreground2}
//             />

//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             {/* 💾 Save Changes Button */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() => updateMutation.mutate()}
//               style={[styles.saveButton]}>
//               <Text style={styles.buttonText}>
//                 {updateMutation.isLoading ? 'Saving...' : 'Save Changes'}
//               </Text>
//             </AppleTouchFeedback>

//             <View
//               style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//               {/* ✅ Close Button */}
//               <View>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={onClose}
//                   style={[
//                     styles.button,
//                     {
//                       backgroundColor: theme.colors.surface3,
//                       paddingHorizontal: 25.0,
//                     },
//                   ]}>
//                   <Text style={styles.buttonText}>Close</Text>
//                 </AppleTouchFeedback>
//               </View>

//               {/* 🗑️ Delete Button */}
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={handleDelete}
//                 style={[styles.deleteButton, {marginLeft: 40}]}>
//                 <Text style={styles.buttonText}>
//                   {deleteMutation.isLoading ? 'Deleting...' : 'Delete'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }

/////////////////

// // components/SavedLookModal/SavedLookPreviewModal.tsx
// import React from 'react';
// import {Modal, View, Image, Text, StyleSheet, Alert} from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok) {
//         console.error('Delete failed:', data);
//         throw new Error(data?.message || 'Failed to delete saved look');
//       }
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert(
//         'Error',
//         err?.message || 'Could not delete the saved look. Please try again.',
//       );
//     },
//   });

//   const handleDelete = () => {
//     if (!look?.id) {
//       Alert.alert('Error', 'Look ID is missing — cannot delete.');
//       return;
//     }
//     Alert.alert(
//       'Delete Saved Look',
//       'Are you sure you want to delete this saved look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => deleteMutation.mutate(look.id),
//         },
//       ],
//     );
//   };

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     name: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     deleteButton: {
//       marginTop: 16,
//       backgroundColor: theme.colors.error || '#D32F2F',
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />
//             <Text style={styles.name}>{look.name}</Text>
//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             <View
//               style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//               {/* ✅ Close Button (resets on press) */}
//               {/* ✅ Close Button */}
//               <View>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={onClose}
//                   style={[styles.button]}>
//                   <Text style={styles.buttonText}>Close</Text>
//                 </AppleTouchFeedback>
//               </View>

//               {/* 🗑️ Delete Button */}
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={handleDelete}
//                 style={[styles.deleteButton, {marginLeft: 40}]}>
//                 <Text style={styles.buttonText}>
//                   {deleteMutation.isLoading ? 'Deleting...' : 'Delete'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }

/////////////////////

// // components/SavedLookModal/SavedLookPreviewModal.tsx
// import React from 'react';
// import {Modal, View, Image, Text, StyleSheet, Alert} from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok) {
//         console.error('Delete failed:', data);
//         throw new Error(data?.message || 'Failed to delete saved look');
//       }
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert(
//         'Error',
//         err?.message || 'Could not delete the saved look. Please try again.',
//       );
//     },
//   });

//   const handleDelete = () => {
//     if (!look?.id) {
//       Alert.alert('Error', 'Look ID is missing — cannot delete.');
//       return;
//     }
//     Alert.alert(
//       'Delete Saved Look',
//       'Are you sure you want to delete this saved look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => deleteMutation.mutate(look.id),
//         },
//       ],
//     );
//   };

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     name: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     deleteButton: {
//       marginTop: 16,
//       backgroundColor: theme.colors.error || '#D32F2F',
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />
//             <Text style={styles.name}>{look.name}</Text>
//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             <View
//               style={{flexDirection: 'row', justifyContent: 'space-between'}}>
//               {/* ✅ Close Button (resets on press) */}
//               {/* ✅ Close Button */}
//               <View>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={onClose}
//                   style={[styles.button]}>
//                   <Text style={styles.buttonText}>Close</Text>
//                 </AppleTouchFeedback>
//               </View>

//               {/* 🗑️ Delete Button */}
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={handleDelete}
//                 style={[styles.deleteButton, {marginLeft: 40}]}>
//                 <Text style={styles.buttonText}>
//                   {deleteMutation.isLoading ? 'Deleting...' : 'Delete'}
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }

///////////////////

// // components/SavedLookModal/SavedLookPreviewModal.tsx
// import React from 'react';
// import {Modal, View, Image, Text, StyleSheet, Alert} from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {id: string; name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await fetch(`${API_BASE_URL}/saved-looks/${id}`, {
//         method: 'DELETE',
//       });
//       const data = await res.json().catch(() => ({}));
//       if (!res.ok) {
//         console.error('Delete failed:', data);
//         throw new Error(data?.message || 'Failed to delete saved look');
//       }
//       return data;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['savedOutfits']});
//       onClose();
//     },
//     onError: (err: any) => {
//       Alert.alert(
//         'Error',
//         err?.message || 'Could not delete the saved look. Please try again.',
//       );
//     },
//   });

//   const handleDelete = () => {
//     if (!look?.id) {
//       Alert.alert('Error', 'Look ID is missing — cannot delete.');
//       return;
//     }
//     Alert.alert(
//       'Delete Saved Look',
//       'Are you sure you want to delete this saved look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => deleteMutation.mutate(look.id),
//         },
//       ],
//     );
//   };

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     name: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     deleteButton: {
//       marginTop: 10,
//       backgroundColor: theme.colors.danger || '#D32F2F',
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />
//             <Text style={styles.name}>{look.name}</Text>
//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             {/* ✅ Close Button */}
//             <View style={{marginBottom: -4}}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={onClose}
//                 style={[styles.button]}>
//                 <Text style={styles.buttonText}>Close</Text>
//               </AppleTouchFeedback>
//             </View>

//             {/* 🗑️ Delete Button */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={handleDelete}
//               style={[styles.deleteButton]}>
//               <Text style={styles.buttonText}>
//                 {deleteMutation.isLoading ? 'Deleting...' : 'Delete'}
//               </Text>
//             </AppleTouchFeedback>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }

////////////////

// // components/SavedLookModal/SavedLookPreviewModal.tsx
// import React from 'react';
// import {Modal, View, Image, Text, StyleSheet} from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     name: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />
//             <Text style={styles.name}>{look.name}</Text>
//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             {/* ✅ light haptic on close */}
//             <View style={{marginBottom: -4}}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={onClose}
//                 style={[styles.button]}>
//                 <Text style={styles.buttonText}>Close</Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }

/////////////////

// // components/SavedLookModal/SavedLookPreviewModal.tsx
// import React from 'react';
// import {Modal, View, Image, Text, StyleSheet} from 'react-native';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {useAppTheme} from '../../context/ThemeContext';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';
// import {tokens} from '../../styles/tokens/tokens';

// type Props = {
//   visible: boolean;
//   onClose: () => void;
//   look: {name: string; image_url: string} | null;
// };

// export default function SavedLookPreviewModal({visible, onClose, look}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();

//   const styles = StyleSheet.create({
//     overlay: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.7)',
//       justifyContent: 'center',
//       alignItems: 'center',
//       padding: 20,
//     },
//     image: {
//       width: '100%',
//       height: undefined,
//       aspectRatio: 3 / 4,
//       borderRadius: 12,
//       marginBottom: 12,
//     },
//     name: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginTop: 12,
//       textAlign: 'center',
//     },
//     url: {
//       fontSize: 12,
//       color: theme.colors.foreground2,
//       marginTop: 4,
//       textAlign: 'center',
//     },
//     button: {
//       marginTop: 16,
//       backgroundColor: theme.colors.button1,
//       paddingVertical: 10,
//       paddingHorizontal: 20,
//       borderRadius: 8,
//     },
//     buttonText: {color: theme.colors.buttonText1, fontWeight: '600'},
//   });

//   if (!look) return null;

//   return (
//     <Modal visible={visible} transparent animationType="fade">
//       <View style={styles.overlay}>
//         <View
//           style={[
//             globalStyles.cardStyles1,
//             {
//               width: '90%',
//               borderRadius: tokens.borderRadius['2xl'],
//               alignItems: 'center',
//               borderColor: theme.colors.surfaceBorder,
//             },
//           ]}>
//           <View
//             style={{
//               alignItems: 'center',
//               paddingVertical: 18,
//               paddingHorizontal: 6,
//             }}>
//             <Image
//               source={{uri: look.image_url}}
//               style={styles.image}
//               resizeMode="contain"
//             />
//             <Text style={styles.name}>{look.name}</Text>
//             <Text style={styles.url} numberOfLines={1}>
//               {look.image_url}
//             </Text>

//             {/* ✅ light haptic on close */}
//             <View style={{marginBottom: -4}}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={onClose}
//                 style={[styles.button]}>
//                 <Text style={styles.buttonText}>Close</Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         </View>
//       </View>
//     </Modal>
//   );
// }
