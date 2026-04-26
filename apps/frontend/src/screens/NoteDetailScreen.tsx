import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
  Pressable,
  Image,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {launchImageLibrary, launchCamera} from 'react-native-image-picker';
import {useAppTheme} from '../context/ThemeContext';
import {useUUID} from '../context/UUIDContext';
import {SafeAreaView} from 'react-native-safe-area-context';
import {uploadImageToGCS} from '../api/uploadImageToGCS';
import {useUpdateNote, useDeleteNote, SavedNote} from '../hooks/useSavedNotes';
import {useExportNotes} from '../hooks/useExportNotes';

type Props = {
  navigate: (screen: any, params?: any) => void;
  params?: {
    note: SavedNote;
  };
};

export default function NoteDetailScreen({navigate, params}: Props) {
  const userId = useUUID();
  const {theme} = useAppTheme();
  const colors = theme.colors;
  const note = params?.note;
  const updateNoteMutation = useUpdateNote();
  const deleteNoteMutation = useDeleteNote();
  const {exportNote} = useExportNotes();

  const [title, setTitle] = useState(note?.title || '');
  const [url, setUrl] = useState(note?.url || '');
  const [content, setContent] = useState(note?.content || '');
  const [tagsInput, setTagsInput] = useState(note?.tags?.join(', ') || '');
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(
    note?.image_url || null,
  );
  const [localImageUri, setLocalImageUri] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Animation refs
  const headerFadeAnim = useRef(new Animated.Value(0)).current;
  const headerSlideAnim = useRef(new Animated.Value(-15)).current;
  const contentFadeAnim = useRef(new Animated.Value(0)).current;
  const contentSlideAnim = useRef(new Animated.Value(30)).current;
  const urlContainerAnim = useRef(new Animated.Value(0)).current;
  const saveBtnScaleAnim = useRef(new Animated.Value(1)).current;
  const deleteBtnScaleAnim = useRef(new Animated.Value(1)).current;

  // Entrance animations
  useEffect(() => {
    Animated.stagger(80, [
      Animated.parallel([
        Animated.timing(headerFadeAnim, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(headerSlideAnim, {
          toValue: 0,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(contentFadeAnim, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(contentSlideAnim, {
          toValue: 0,
          useNativeDriver: true,
          speed: 12,
          bounciness: 6,
        }),
      ]),
      Animated.spring(urlContainerAnim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 10,
        bounciness: 8,
      }),
    ]).start();
  }, []);

  const h = (
    type:
      | 'impactLight'
      | 'impactMedium'
      | 'impactHeavy'
      | 'notificationSuccess',
  ) =>
    ReactNativeHapticFeedback.trigger(type, {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });

  // Track changes
  useEffect(() => {
    if (!note) return;
    const changed =
      title !== (note.title || '') ||
      url !== (note.url || '') ||
      content !== (note.content || '') ||
      tagsInput !== (note.tags?.join(', ') || '') ||
      localImageUri !== null ||
      imageUrl !== (note.image_url || null);
    setHasChanges(changed);
  }, [title, url, content, tagsInput, note, localImageUri, imageUrl]);

  const pickImage = async () => {
    h('impactLight');
    const result = await launchImageLibrary({
      mediaType: 'photo',
      quality: 1.0,
      maxWidth: 2048,
      maxHeight: 2048,
      selectionLimit: 1,
    });
    if (result.assets?.[0]?.uri) {
      setLocalImageUri(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    h('impactLight');
    const result = await launchCamera({
      mediaType: 'photo',
      quality: 1.0,
      maxWidth: 2048,
      maxHeight: 2048,
    });
    if (result.assets?.[0]?.uri) {
      setLocalImageUri(result.assets[0].uri);
    }
  };

  const removeImage = () => {
    h('impactLight');
    setLocalImageUri(null);
    setImageUrl(null);
  };

  const handleSave = async () => {
    if (!note) return;

    setSaving(true);
    h('impactMedium');

    try {
      let finalImageUrl = imageUrl;

      // Upload new image if selected
      if (localImageUri && userId) {
        setUploadingImage(true);
        const filename = `note-${Date.now()}.jpg`;
        const {publicUrl} = await uploadImageToGCS({
          localUri: localImageUri,
          filename,
          userId,
        });
        finalImageUrl = publicUrl;
        setUploadingImage(false);
      }

      const tags = tagsInput
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      updateNoteMutation.mutate(
        {
          noteId: note.id,
          userId: userId || '',
          url: url.trim() || undefined,
          title: title.trim() || undefined,
          content: content.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          image_url: finalImageUrl || undefined,
        },
        {
          onSuccess: () => {
            h('notificationSuccess');
            setHasChanges(false);
            navigate('Notes');
          },
          onError: () => {
            Alert.alert('Error', 'Failed to save note. Please try again.');
          },
          onSettled: () => {
            setSaving(false);
            setUploadingImage(false);
          },
        },
      );
    } catch (err) {
      Alert.alert('Error', 'Failed to save note. Please try again.');
      setSaving(false);
      setUploadingImage(false);
    }
  };

  const handleDelete = () => {
    if (!note) return;
    h('impactMedium');
    Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteNoteMutation.mutate(
            {noteId: note.id, userId: userId || ''},
            {
              onSuccess: () => {
                h('notificationSuccess');
                navigate('Notes');
              },
              onError: () => {
                Alert.alert('Error', 'Failed to delete note');
              },
            },
          );
        },
      },
    ]);
  };

  const openUrl = () => {
    if (url) {
      let normalizedUrl = url.trim();
      // Add https:// if no protocol specified
      if (
        !normalizedUrl.startsWith('http://') &&
        !normalizedUrl.startsWith('https://')
      ) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      navigate('WebBrowser', {url: normalizedUrl});
    }
  };

  const handleBack = () => {
    if (hasChanges) {
      Alert.alert('Unsaved Changes', 'Do you want to save your changes?', [
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => navigate('Notes'),
        },
        {text: 'Cancel', style: 'cancel'},
        {text: 'Save', onPress: handleSave},
      ]);
    } else {
      navigate('Notes');
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Button press animations
  const handleSavePressIn = () => {
    Animated.spring(saveBtnScaleAnim, {
      toValue: 0.95,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handleSavePressOut = () => {
    Animated.spring(saveBtnScaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handleDeletePressIn = () => {
    Animated.spring(deleteBtnScaleAnim, {
      toValue: 0.9,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handleDeletePressOut = () => {
    Animated.spring(deleteBtnScaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const styles = StyleSheet.create({
    screen: {
      flex: 1,
      paddingTop: 60,
    },
    container: {
      flex: 1,
      paddingHorizontal: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    backText: {
      fontSize: 17,
      color: theme.colors.primary,
      fontWeight: '500',
    },
    exportBtn: {
      width: 40,
      height: 40,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.button1,
    },
    deleteBtn: {
      backgroundColor: theme.colors.error,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: 8,
      overflow: 'hidden',
    },
    saveBtn: {
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 8,
      overflow: 'hidden',
    },
    saveBtnActive: {
      backgroundColor: theme.colors.button1,
    },
    saveBtnInactive: {
      backgroundColor: theme.colors.button1 + '30',
    },
    saveBtnText: {
      fontSize: 15,
      fontWeight: '600',
      color: hasChanges ? '#FFFFFF' : colors.buttonText1,
    },
    dateContainer: {
      alignItems: 'center',
      marginBottom: 24,
    },
    dateText: {
      fontSize: 13,
      color: colors.muted,
      textAlign: 'center',
    },
    formContainer: {
      flex: 1,
    },
    titleInputContainer: {
      marginBottom: 16,
    },
    titleInput: {
      fontSize: 28,
      fontWeight: '700',
      color: colors.foreground,
      paddingVertical: 8,
      letterSpacing: -0.5,
    },
    titleUnderline: {
      height: 2,
      backgroundColor: theme.colors.primary + '30',
      borderRadius: 1,
      marginTop: 4,
    },
    urlContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.input2,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 20,
      gap: 10,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
    },
    urlIconContainer: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: theme.colors.primary + '15',
      justifyContent: 'center',
      alignItems: 'center',
    },
    urlInput: {
      flex: 1,
      fontSize: 15,
      color: colors.foreground,
    },
    urlOpenBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.colors.button1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    contentContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      padding: 16,
      minHeight: 250,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
    },
    contentLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.muted,
      marginBottom: 8,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    contentInput: {
      fontSize: 16,
      color: colors.foreground,
      lineHeight: 26,
      minHeight: 200,
      textAlignVertical: 'top',
    },
    tagsContainer: {
      marginTop: 20,
      paddingTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.inputBorder,
    },
    tagsLabel: {
      fontSize: 13,
      color: colors.muted,
      marginBottom: 8,
    },
    tagsInput: {
      fontSize: 15,
      color: colors.foreground,
      paddingVertical: 8,
    },
    imageSection: {
      marginTop: 20,
    },
    imageSectionLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.muted,
      marginBottom: 12,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    imagePickerRow: {
      flexDirection: 'row',
      gap: 12,
    },
    imagePickerBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: theme.colors.surface,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: theme.colors.inputBorder,
      borderStyle: 'dashed',
    },
    imagePickerBtnText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.foreground,
    },
    imagePreviewContainer: {
      borderRadius: 16,
      overflow: 'hidden',
      position: 'relative',
    },
    imagePreview: {
      width: '100%',
      height: 200,
      borderRadius: 16,
    },
    removeImageBtn: {
      position: 'absolute',
      top: 8,
      right: 8,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    uploadingOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 16,
    },
    uploadingText: {
      color: '#FFFFFF',
      marginTop: 8,
      fontSize: 14,
      fontWeight: '500',
    },
    keyboardDismissArea: {
      height: 200,
      marginTop: 20,
    },
  });

  if (!userId || !note) return null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{flex: 1}}>
        <View style={styles.container}>
          <Animated.View
            style={[
              styles.header,
              {
                opacity: headerFadeAnim,
                transform: [{translateY: headerSlideAnim}],
              },
            ]}>
            <Pressable style={styles.headerLeft} onPress={handleBack}>
              <MaterialIcons
                name="arrow-back-ios"
                size={20}
                color={theme.colors.primary}
              />
              <Text style={styles.backText}>Notes</Text>
            </Pressable>
            <View style={styles.headerRight}>
              <Pressable
                style={styles.exportBtn}
                onPress={() => note && exportNote(note)}>
                <MaterialIcons
                  name="ios-share"
                  size={20}
                  color={theme.colors.buttonText1}
                />
              </Pressable>
              <Animated.View style={{transform: [{scale: deleteBtnScaleAnim}]}}>
                <Pressable
                  style={styles.deleteBtn}
                  onPress={handleDelete}
                  onPressIn={handleDeletePressIn}
                  onPressOut={handleDeletePressOut}>
                  <MaterialIcons
                    name="delete-outline"
                    size={22}
                    color={theme.colors.buttonText1}
                  />
                  <Text style={{color: theme.colors.buttonText1}}>Delete</Text>
                </Pressable>
              </Animated.View>
              <Animated.View style={{transform: [{scale: saveBtnScaleAnim}]}}>
                <Pressable
                  style={[
                    styles.saveBtn,
                    hasChanges ? styles.saveBtnActive : styles.saveBtnInactive,
                  ]}
                  onPress={handleSave}
                  onPressIn={handleSavePressIn}
                  onPressOut={handleSavePressOut}
                  disabled={!hasChanges || saving}>
                  <Text style={styles.saveBtnText}>
                    {saving ? 'Saving...' : 'Done'}
                  </Text>
                </Pressable>
              </Animated.View>
            </View>
          </Animated.View>

          <Animated.View
            style={[
              styles.dateContainer,
              {
                opacity: headerFadeAnim,
              },
            ]}>
            <Text style={styles.dateText}>
              {formatDate(note.updated_at || note.created_at)}
            </Text>
          </Animated.View>

          <ScrollView
            style={styles.formContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={Keyboard.dismiss}>
            <Animated.View
              style={[
                styles.titleInputContainer,
                {
                  opacity: contentFadeAnim,
                  transform: [{translateY: contentSlideAnim}],
                },
              ]}>
              <TextInput
                placeholder="Title"
                placeholderTextColor={colors.muted}
                style={styles.titleInput}
                value={title}
                onChangeText={setTitle}
              />
              <View style={styles.titleUnderline} />
            </Animated.View>

            <Animated.View
              style={[
                styles.urlContainer,
                {
                  opacity: urlContainerAnim,
                  transform: [
                    {
                      scale: urlContainerAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.95, 1],
                      }),
                    },
                  ],
                },
              ]}>
              <View style={styles.urlIconContainer}>
                <MaterialIcons
                  name="link"
                  size={18}
                  color={theme.colors.buttonText1}
                />
              </View>
              <TextInput
                placeholder="URL"
                placeholderTextColor={colors.muted}
                style={styles.urlInput}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              {url ? (
                <TouchableOpacity style={styles.urlOpenBtn} onPress={openUrl}>
                  <MaterialIcons
                    name="open-in-new"
                    size={18}
                    color={theme.colors.buttonText1}
                  />
                </TouchableOpacity>
              ) : null}
            </Animated.View>

            <Pressable onPress={Keyboard.dismiss}>
              <Animated.View
                style={[
                  styles.contentContainer,
                  {
                    opacity: contentFadeAnim,
                    transform: [{translateY: contentSlideAnim}],
                  },
                ]}>
                <Text style={styles.contentLabel}>Notes</Text>
                <TextInput
                  placeholder="Start typing..."
                  placeholderTextColor={colors.muted}
                  style={styles.contentInput}
                  value={content}
                  onChangeText={setContent}
                  multiline
                  onBlur={Keyboard.dismiss}
                />
              </Animated.View>
            </Pressable>

            {/* Image Section */}
            <Animated.View
              style={[
                styles.imageSection,
                {
                  opacity: contentFadeAnim,
                  transform: [{translateY: contentSlideAnim}],
                },
              ]}>
              <Text style={styles.imageSectionLabel}>Image</Text>

              {!localImageUri && !imageUrl ? (
                <View style={styles.imagePickerRow}>
                  <Pressable style={styles.imagePickerBtn} onPress={pickImage}>
                    <MaterialIcons
                      name="photo-library"
                      size={20}
                      color={theme.colors.primary}
                    />
                    <Text style={styles.imagePickerBtnText}>Gallery</Text>
                  </Pressable>
                  <Pressable style={styles.imagePickerBtn} onPress={takePhoto}>
                    <MaterialIcons
                      name="camera-alt"
                      size={20}
                      color={theme.colors.primary}
                    />
                    <Text style={styles.imagePickerBtnText}>Camera</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.imagePreviewContainer}>
                  <Image
                    source={{uri: localImageUri || imageUrl || ''}}
                    style={styles.imagePreview}
                    resizeMode="cover"
                  />
                  <Pressable
                    style={styles.removeImageBtn}
                    onPress={removeImage}>
                    <MaterialIcons name="close" size={20} color="#FFFFFF" />
                  </Pressable>
                  {uploadingImage && (
                    <View style={styles.uploadingOverlay}>
                      <ActivityIndicator size="large" color="#FFFFFF" />
                      <Text style={styles.uploadingText}>Uploading...</Text>
                    </View>
                  )}
                </View>
              )}
            </Animated.View>

            {/* Spacer to dismiss keyboard when tapping below content */}
            <Pressable
              onPress={Keyboard.dismiss}
              style={styles.keyboardDismissArea}
            />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/////////////

// import React, {useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   TextInput,
//   TouchableOpacity,
//   Alert,
//   ScrollView,
//   KeyboardAvoidingView,
//   Platform,
//   Linking,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {SafeAreaView} from 'react-native-safe-area-context';

// type SavedNote = {
//   id: string;
//   user_id: string;
//   url?: string;
//   title?: string;
//   content?: string;
//   tags?: string[];
//   created_at: string;
//   updated_at: string;
// };

// type Props = {
//   navigate: (screen: any, params?: any) => void;
//   params?: {
//     note: SavedNote;
//   };
// };

// export default function NoteDetailScreen({navigate, params}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const note = params?.note;

//   const [title, setTitle] = useState(note?.title || '');
//   const [url, setUrl] = useState(note?.url || '');
//   const [content, setContent] = useState(note?.content || '');
//   const [tagsInput, setTagsInput] = useState(note?.tags?.join(', ') || '');
//   const [saving, setSaving] = useState(false);
//   const [hasChanges, setHasChanges] = useState(false);

//   const h = (
//     type:
//       | 'impactLight'
//       | 'impactMedium'
//       | 'impactHeavy'
//       | 'notificationSuccess',
//   ) =>
//     ReactNativeHapticFeedback.trigger(type, {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   // Track changes
//   useEffect(() => {
//     if (!note) return;
//     const changed =
//       title !== (note.title || '') ||
//       url !== (note.url || '') ||
//       content !== (note.content || '') ||
//       tagsInput !== (note.tags?.join(', ') || '');
//     setHasChanges(changed);
//   }, [title, url, content, tagsInput, note]);

//   const handleSave = async () => {
//     if (!note) return;

//     setSaving(true);
//     h('impactMedium');

//     try {
//       const tags = tagsInput
//         .split(',')
//         .map(t => t.trim())
//         .filter(t => t.length > 0);

//       const res = await fetch(`${API_BASE_URL}/saved-notes/${note.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//           url: url.trim() || null,
//           title: title.trim() || null,
//           content: content.trim() || null,
//           tags: tags.length > 0 ? tags : null,
//         }),
//       });

//       if (!res.ok) {
//         throw new Error('Failed to save note');
//       }

//       h('notificationSuccess');
//       setHasChanges(false);
//       navigate('Notes');
//     } catch (err) {
//       Alert.alert('Error', 'Failed to save note. Please try again.');
//     } finally {
//       setSaving(false);
//     }
//   };

//   const handleDelete = () => {
//     if (!note) return;
//     h('impactMedium');
//     Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
//       {text: 'Cancel', style: 'cancel'},
//       {
//         text: 'Delete',
//         style: 'destructive',
//         onPress: async () => {
//           try {
//             await fetch(`${API_BASE_URL}/saved-notes/${note.id}`, {
//               method: 'DELETE',
//             });
//             h('notificationSuccess');
//             navigate('Notes');
//           } catch (err) {
//             Alert.alert('Error', 'Failed to delete note');
//           }
//         },
//       },
//     ]);
//   };

//   const openUrl = () => {
//     if (url) {
//       Linking.openURL(url).catch(() => {
//         Alert.alert('Error', 'Could not open URL');
//       });
//     }
//   };

//   const handleBack = () => {
//     if (hasChanges) {
//       Alert.alert('Unsaved Changes', 'Do you want to save your changes?', [
//         {text: 'Discard', style: 'destructive', onPress: () => navigate('Notes')},
//         {text: 'Cancel', style: 'cancel'},
//         {text: 'Save', onPress: handleSave},
//       ]);
//     } else {
//       navigate('Notes');
//     }
//   };

//   const formatDate = (dateStr: string) => {
//     const date = new Date(dateStr);
//     return date.toLocaleDateString('en-US', {
//       weekday: 'long',
//       month: 'long',
//       day: 'numeric',
//       year: 'numeric',
//       hour: 'numeric',
//       minute: '2-digit',
//     });
//   };

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       paddingTop: 60,
//     },
//     container: {
//       flex: 1,
//       paddingHorizontal: 16,
//     },
//     header: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'space-between',
//       paddingVertical: 12,
//     },
//     headerLeft: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 8,
//     },
//     headerRight: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 16,
//     },
//     backText: {
//       fontSize: 17,
//       color: theme.colors.primary,
//     },
//     saveBtn: {
//       opacity: hasChanges ? 1 : 0.4,
//     },
//     saveBtnText: {
//       fontSize: 17,
//       color: theme.colors.primary,
//       fontWeight: '600',
//     },
//     dateText: {
//       fontSize: 13,
//       color: colors.muted,
//       textAlign: 'center',
//       marginBottom: 20,
//     },
//     formContainer: {
//       flex: 1,
//     },
//     titleInput: {
//       fontSize: 24,
//       fontWeight: '700',
//       color: colors.foreground,
//       paddingVertical: 8,
//       marginBottom: 8,
//     },
//     urlContainer: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: theme.colors.input2,
//       borderRadius: 8,
//       paddingHorizontal: 12,
//       paddingVertical: 10,
//       marginBottom: 16,
//       gap: 8,
//     },
//     urlInput: {
//       flex: 1,
//       fontSize: 15,
//       color: colors.foreground,
//     },
//     urlOpenBtn: {
//       padding: 4,
//     },
//     contentInput: {
//       fontSize: 16,
//       color: colors.foreground,
//       lineHeight: 24,
//       minHeight: 200,
//       textAlignVertical: 'top',
//     },
//     tagsContainer: {
//       marginTop: 20,
//       paddingTop: 16,
//       borderTopWidth: StyleSheet.hairlineWidth,
//       borderTopColor: theme.colors.inputBorder,
//     },
//     tagsLabel: {
//       fontSize: 13,
//       color: colors.muted,
//       marginBottom: 8,
//     },
//     tagsInput: {
//       fontSize: 15,
//       color: colors.foreground,
//       paddingVertical: 8,
//     },
//   });

//   if (!userId || !note) return null;

//   return (
//     <SafeAreaView style={styles.screen} edges={['top']}>
//       <KeyboardAvoidingView
//         behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
//         style={{flex: 1}}>
//         <View style={styles.container}>
//           <View style={styles.header}>
//             <TouchableOpacity
//               style={styles.headerLeft}
//               onPress={handleBack}>
//               <MaterialIcons
//                 name="arrow-back-ios"
//                 size={20}
//                 color={theme.colors.primary}
//               />
//               <Text style={styles.backText}>Notes</Text>
//             </TouchableOpacity>
//             <View style={styles.headerRight}>
//               <TouchableOpacity onPress={handleDelete}>
//                 <MaterialIcons
//                   name="delete-outline"
//                   size={24}
//                   color={colors.muted}
//                 />
//               </TouchableOpacity>
//               <TouchableOpacity
//                 style={styles.saveBtn}
//                 onPress={handleSave}
//                 disabled={!hasChanges || saving}>
//                 <Text style={styles.saveBtnText}>
//                   {saving ? 'Saving...' : 'Done'}
//                 </Text>
//               </TouchableOpacity>
//             </View>
//           </View>

//           <Text style={styles.dateText}>
//             {formatDate(note.updated_at || note.created_at)}
//           </Text>

//           <ScrollView
//             style={styles.formContainer}
//             showsVerticalScrollIndicator={false}
//             keyboardShouldPersistTaps="handled">
//             <TextInput
//               placeholder="Title"
//               placeholderTextColor={colors.muted}
//               style={styles.titleInput}
//               value={title}
//               onChangeText={setTitle}
//             />

//             {(url || !content) && (
//               <View style={styles.urlContainer}>
//                 <MaterialIcons name="link" size={20} color={colors.muted} />
//                 <TextInput
//                   placeholder="URL"
//                   placeholderTextColor={colors.muted}
//                   style={styles.urlInput}
//                   value={url}
//                   onChangeText={setUrl}
//                   autoCapitalize="none"
//                   autoCorrect={false}
//                   keyboardType="url"
//                 />
//                 {url ? (
//                   <TouchableOpacity style={styles.urlOpenBtn} onPress={openUrl}>
//                     <MaterialIcons
//                       name="open-in-new"
//                       size={20}
//                       color={theme.colors.primary}
//                     />
//                   </TouchableOpacity>
//                 ) : null}
//               </View>
//             )}

//             <TextInput
//               placeholder="Start typing..."
//               placeholderTextColor={colors.muted}
//               style={styles.contentInput}
//               value={content}
//               onChangeText={setContent}
//               multiline
//             />

//             <View style={styles.tagsContainer}>
//               <Text style={styles.tagsLabel}>TAGS</Text>
//               <TextInput
//                 placeholder="Add tags separated by commas"
//                 placeholderTextColor={colors.muted}
//                 style={styles.tagsInput}
//                 value={tagsInput}
//                 onChangeText={setTagsInput}
//               />
//             </View>
//           </ScrollView>
//         </View>
//       </KeyboardAvoidingView>
//     </SafeAreaView>
//   );
// }
