import React, {useEffect, useState, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
  ScrollView,
  Animated,
  Easing,
  Pressable,
  RefreshControl,
  Modal,
  Image,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import LinearGradient from 'react-native-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useUUID} from '../context/UUIDContext';
import {
  useSavedNotes,
  useDeleteNote,
  useUpdateNote,
  SavedNote,
} from '../hooks/useSavedNotes';
import {useExportNotes} from '../hooks/useExportNotes';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useAppTheme} from '../context/ThemeContext';
import {tokens} from '../styles/tokens/tokens';
import {fontScale, moderateScale} from '../utils/scale';

const CARD_GAP = 10;
const NOTES_VIEW_MODE_KEY = 'notes_view_mode';

// Color options for notes
const NOTE_COLORS = [
  {id: 'green', color: '#34C759', label: 'Green'},
  {id: 'red', color: '#FF3B30', label: 'Red'},
  {id: 'blue', color: '#007AFF', label: 'Blue'},
  {id: 'purple', color: '#AF52DE', label: 'Purple'},
  {id: 'orange', color: '#FF9500', label: 'Orange'},
  {id: 'default', color: null, label: 'Default'},
];

// Animated card component
const AnimatedCard = ({
  children,
  onPress,
  onLongPress,
  style,
  index,
  noteColor,
}: {
  children: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  style?: any;
  index: number;
  noteColor?: string | null;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    // Fast stagger: 20ms per card, max 100ms delay for snappy feel
    const delay = Math.min(index * 20, 100);
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 200,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, fadeAnim, slideAnim]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.95,
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
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}>
      <Animated.View
        style={[
          style,
          {
            opacity: fadeAnim,
            transform: [{scale: scaleAnim}, {translateY: slideAnim}],
          },
          noteColor && {
            borderLeftWidth: 4,
            borderLeftColor: noteColor,
          },
        ]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

// Color Picker Modal Component
const ColorPickerModal = ({
  visible,
  onClose,
  onSelectColor,
  currentColor,
  theme,
}: {
  visible: boolean;
  onClose: () => void;
  onSelectColor: (colorId: string) => void;
  currentColor?: string | null;
  theme: any;
}) => {
  const slideAnim = useRef(new Animated.Value(300)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          speed: 14,
          bounciness: 4,
        }),
        Animated.timing(backdropAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 300,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(backdropAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, slideAnim, backdropAnim]);

  const modalStyles = StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    modalContainer: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingTop: 12,
      paddingBottom: 40,
      paddingHorizontal: 24,
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: theme.colors.muted + '50',
      borderRadius: 2,
      alignSelf: 'center',
      marginBottom: 20,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: 20,
      textAlign: 'center',
    },
    colorsContainer: {
      flexDirection: 'row',
      justifyContent: 'center',
      flexWrap: 'wrap',
      gap: 16,
    },
    colorOption: {
      alignItems: 'center',
      gap: 8,
    },
    colorDot: {
      width: 48,
      height: 48,
      borderRadius: 24,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 3,
      borderColor: 'transparent',
    },
    colorDotSelected: {
      borderColor: theme.colors.foreground,
    },
    colorDotDefault: {
      backgroundColor: theme.colors.surface,
      borderWidth: 2,
      borderColor: theme.colors.muted + '40',
    },
    colorLabel: {
      fontSize: 12,
      color: theme.colors.muted,
      fontWeight: '500',
    },
    cancelBtn: {
      marginTop: 24,
      paddingVertical: 14,
      borderRadius: 12,
      backgroundColor: theme.colors.muted + '20',
      alignItems: 'center',
    },
    cancelBtnText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
  });

  return (
    <Modal visible={visible} transparent animationType="none">
      <Animated.View style={[modalStyles.backdrop, {opacity: backdropAnim}]}>
        <Pressable style={{flex: 1}} onPress={onClose} />
        <Animated.View
          style={[
            modalStyles.modalContainer,
            {transform: [{translateY: slideAnim}]},
          ]}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.title}>Choose Color</Text>
          <View style={modalStyles.colorsContainer}>
            {NOTE_COLORS.map(colorOption => {
              const isSelected = currentColor === colorOption.id;
              const isDefault = colorOption.id === 'default';

              return (
                <Pressable
                  key={colorOption.id}
                  style={modalStyles.colorOption}
                  onPress={() => {
                    ReactNativeHapticFeedback.trigger('impactLight', {
                      enableVibrateFallback: true,
                      ignoreAndroidSystemSettings: false,
                    });
                    onSelectColor(colorOption.id);
                  }}>
                  <View
                    style={[
                      modalStyles.colorDot,
                      isDefault
                        ? modalStyles.colorDotDefault
                        : {backgroundColor: colorOption.color || undefined},
                      isSelected && modalStyles.colorDotSelected,
                    ]}>
                    {isSelected && (
                      <MaterialIcons
                        name="check"
                        size={24}
                        color={isDefault ? theme.colors.foreground : '#FFFFFF'}
                      />
                    )}
                  </View>
                  <Text style={modalStyles.colorLabel}>
                    {colorOption.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable style={modalStyles.cancelBtn} onPress={onClose}>
            <Text style={modalStyles.cancelBtnText}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
};

// SavedNote type is imported from useSavedNotes hook

type Props = {
  navigate: (screen: any, params?: any) => void;
};

type ViewMode = 'grid' | 'list';
type SortMode = 'recent' | 'color';

export default function NotesScreen({navigate}: Props) {
  const userId = useUUID();
  const {theme} = useAppTheme();
  const colors = theme.colors;

  // TanStack Query hooks
  const {data: notes = [], isLoading, refetch} = useSavedNotes(userId || '');
  const deleteNoteMutation = useDeleteNote();
  const updateNoteMutation = useUpdateNote();
  const {exportAllNotes} = useExportNotes();

  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [colorModalVisible, setColorModalVisible] = useState(false);
  const [selectedNoteForColor, setSelectedNoteForColor] =
    useState<SavedNote | null>(null);

  // Animation refs
  const headerFadeAnim = useRef(new Animated.Value(0)).current;
  const headerSlideAnim = useRef(new Animated.Value(-20)).current;
  const searchFadeAnim = useRef(new Animated.Value(0)).current;
  const searchScaleAnim = useRef(new Animated.Value(0.95)).current;
  const fabScaleAnim = useRef(new Animated.Value(0)).current;
  const emptyStateAnim = useRef(new Animated.Value(0)).current;
  const searchFocusAnim = useRef(new Animated.Value(0)).current;
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  // Load saved view mode on mount
  useEffect(() => {
    AsyncStorage.getItem(NOTES_VIEW_MODE_KEY).then(saved => {
      if (saved === 'grid' || saved === 'list') {
        setViewMode(saved);
      }
    });
  }, []);

  // Entrance animations - run all in parallel for instant feel
  useEffect(() => {
    Animated.parallel([
      Animated.timing(headerFadeAnim, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(headerSlideAnim, {
        toValue: 0,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(searchFadeAnim, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(searchScaleAnim, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(fabScaleAnim, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // Empty state animation
  useEffect(() => {
    if (!isLoading && notes.length === 0) {
      Animated.spring(emptyStateAnim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 8,
        bounciness: 10,
      }).start();
    }
  }, [isLoading, notes.length]);

  // Search focus animation
  useEffect(() => {
    Animated.timing(searchFocusAnim, {
      toValue: isSearchFocused ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [isSearchFocused]);

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

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const deleteNote = async (id: string) => {
    h('impactMedium');
    Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteNoteMutation.mutate(
            {noteId: id, userId: userId || ''},
            {
              onError: () => {
                Alert.alert('Error', 'Failed to delete note');
              },
            },
          );
        },
      },
    ]);
  };

  const updateNoteColor = (noteId: string, colorId: string) => {
    const newColor = colorId === 'default' ? null : colorId;
    updateNoteMutation.mutate({
      noteId,
      userId: userId || '',
      color: newColor,
    });
  };

  const openColorPicker = (note: SavedNote) => {
    h('impactLight');
    setSelectedNoteForColor(note);
    setColorModalVisible(true);
  };

  const handleColorSelect = (colorId: string) => {
    if (selectedNoteForColor) {
      updateNoteColor(selectedNoteForColor.id, colorId);
    }
    setColorModalVisible(false);
    setSelectedNoteForColor(null);
  };

  const filteredNotes = notes.filter(note => {
    const query = searchQuery.toLowerCase();
    return (
      note.title?.toLowerCase().includes(query) ||
      note.content?.toLowerCase().includes(query) ||
      note.url?.toLowerCase().includes(query)
    );
  });

  // Interpolate search border color based on focus
  const searchBorderColor = searchFocusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.colors.inputBorder, theme.colors.primary],
  });

  const getNoteColor = (note: SavedNote) => {
    if (!note.color) return null;
    const colorOption = NOTE_COLORS.find(c => c.id === note.color);
    return colorOption?.color || null;
  };

  const styles = StyleSheet.create({
    screen: {
      flex: 1,
      paddingTop: 55,
    },
    container: {
      flex: 1,
      paddingHorizontal: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 16,
      gap: 12,
    },
    title: {
      fontSize: 28,
      fontWeight: '700',
      color: colors.foreground,
      flex: 1,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    viewToggle: {
      width: 40,
      height: 40,
      borderRadius: 8,
      backgroundColor: theme.colors.button1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sortToggle: {
      width: 40,
      height: 40,
      borderRadius: 8,
      backgroundColor: theme.colors.button1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sortToggleActive: {
      backgroundColor: theme.colors.button1 + '20',
    },
    exportBtn: {
      width: 40,
      height: 40,
      borderRadius: 8,
      backgroundColor: theme.colors.button1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    searchContainer: {
      marginBottom: 20,
    },
    searchInputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      paddingHorizontal: 16,
      borderWidth: 1.5,
      overflow: 'hidden',
    },
    searchIcon: {
      marginRight: 12,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 14,
      fontSize: 16,
      color: colors.foreground,
    },
    searchClearBtn: {
      padding: 4,
    },
    statsRow: {
      flexDirection: 'row',
      marginBottom: 20,
      gap: 10,
    },
    statCard: {
      flex: 1,
      // backgroundColor: '#ff6806',
      backgroundColor: theme.colors.surface3,
      borderRadius: 16,
      padding: 16,
      alignItems: 'center',
    },
    statNumber: {
      fontSize: 28,
      color: theme.colors.buttonText1,
      fontWeight: '700',
    },
    statLabel: {
      fontSize: 16,
      color: theme.colors.buttonText1,
      marginTop: 4,
      // textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontWeight: '700',
    },
    sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
      marginTop: 8,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.foreground,
    },
    // Grid cards container
    // Pinterest-style masonry container
    masonryContainer: {
      flexDirection: 'row',
      paddingBottom: 140,
    },
    masonryColumn: {
      flex: 1,
      gap: CARD_GAP,
    },
    masonryColumnLeft: {
      marginRight: CARD_GAP / 2,
    },
    masonryColumnRight: {
      marginLeft: CARD_GAP / 2,
    },
    // List cards container
    listContainer: {
      gap: 10,
      paddingBottom: 140,
    },
    // Masonry grid card (auto-height for Pinterest layout)
    gridCard: {
      width: '100%',
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xxl,
      paddingVertical: 16,
      paddingHorizontal: 16,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 4},
      shadowOpacity: 0.08,
      shadowRadius: 12,
      elevation: 4,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    // Grid card without padding for image cards
    gridCardWithImage: {
      paddingVertical: 0,
      paddingHorizontal: 0,
    },
    gridCardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      // marginBottom: 10,
    },
    gridCardIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: theme.colors.primary + '15',
      justifyContent: 'center',
      alignItems: 'center',
    },
    gridCardColorBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.muted + '20',
    },
    gridCardTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.foreground,
      marginBottom: 8,
      lineHeight: 22,
    },
    gridCardPreviewContainer: {
      flex: 1,
      overflow: 'hidden',
    },
    gridCardPreview: {
      fontSize: 14,
      color: colors.muted,
      lineHeight: 18,
      fontWeight: '500',
    },
    gridCardFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 8,
      gap: 8,
    },
    gridCardDate: {
      fontSize: 11,
      color: colors.muted,
      fontWeight: '500',
    },
    gridCardTag: {
      backgroundColor: theme.colors.primary + '15',
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 8,
    },
    gridCardTagText: {
      fontSize: 10,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    // Full-width image at top of card (edge to edge)
    gridCardImage: {
      width: '100%',
      height: 150,
      borderTopLeftRadius: tokens.borderRadius.xxl,
      borderTopRightRadius: tokens.borderRadius.xxl,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    },
    // Content wrapper with padding for cards with images
    gridCardContent: {
      flex: 1,
      paddingHorizontal: 16,
      paddingVertical: 20,
      flexDirection: 'column',
    },
    listCardImage: {
      width: 64,
      height: 64,
      borderRadius: 12,
    },
    // List card
    listCard: {
      width: '100%',
      backgroundColor: theme.colors.surface,
      borderRadius: 14,
      padding: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 2},
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    listCardIcon: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: theme.colors.primary + '15',
      justifyContent: 'center',
      alignItems: 'center',
    },
    listCardContent: {
      flex: 1,
    },
    listCardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.foreground,
      marginBottom: 4,
    },
    listCardPreview: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.muted,
      lineHeight: 18,
      marginBottom: 4,
    },
    listCardDate: {
      fontSize: 12,
      color: colors.muted,
    },
    listCardActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    listCardColorBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.muted + '20',
    },
    listSectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.muted,
      marginTop: 16,
      marginBottom: 10,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    listSectionCards: {
      gap: 6,
    },
    colorSectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 22,
      marginBottom: 10,
    },
    colorSectionDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
    },
    colorSectionTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.foreground,
    },
    colorSectionCount: {
      fontSize: 13,
      color: colors.muted,
      fontWeight: '500',
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 60,
    },
    emptyIconContainer: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: theme.colors.primary + '10',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 24,
    },
    emptyTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.foreground,
      marginBottom: 10,
    },
    emptyText: {
      fontSize: 15,
      color: colors.muted,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: 40,
    },
    addButton: {
      position: 'absolute',
      bottom: 100,
      right: 20,
      width: 54,
      height: 54,
      borderRadius: 32,
      borderWidth: 1,
      borderColor: theme.colors.foreground,
      backgroundColor: 'rgba(54, 54, 54, 0.52)',
      alignItems: 'center',
      justifyContent: 'center',
    },

    addButtonShadow: {
      shadowColor: theme.colors.primary,
      shadowOffset: {width: 0, height: 8},
      shadowOpacity: 0.4,
      shadowRadius: 16,
      elevation: 12,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 100,
    },
    loadingDots: {
      flexDirection: 'row',
      gap: 8,
    },
    loadingDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.colors.primary,
    },
  });

  if (!userId) return null;

  // Format time
  const formatNoteTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const noteDate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );

    if (noteDate >= today) {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
    if (noteDate >= yesterday) {
      return 'Yesterday';
    }
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const openNote = (note: SavedNote) => {
    h('impactLight');
    navigate('NoteDetail', {note});
  };

  const getPreview = (note: SavedNote) => {
    if (note.content) {
      return note.content.split('\n')[0].substring(0, 100);
    }
    if (note.url) {
      return note.url;
    }
    return '';
  };

  // FAB press animation
  const handleFabPressIn = () => {
    Animated.spring(fabScaleAnim, {
      toValue: 0.9,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handleFabPressOut = () => {
    Animated.spring(fabScaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const toggleViewMode = () => {
    h('impactLight');
    setViewMode(prev => {
      const newMode = prev === 'grid' ? 'list' : 'grid';
      AsyncStorage.setItem(NOTES_VIEW_MODE_KEY, newMode);
      return newMode;
    });
  };

  const toggleSortMode = () => {
    h('impactLight');
    setSortMode(prev => (prev === 'recent' ? 'color' : 'recent'));
  };

  // Group notes by color
  const groupNotesByColor = (notes: SavedNote[]) => {
    const colorOrder = NOTE_COLORS.map(c => c.id);
    const groups: {
      colorId: string;
      colorValue: string | null;
      label: string;
      notes: SavedNote[];
    }[] = [];

    // Create groups for each color that has notes
    NOTE_COLORS.forEach(colorOption => {
      const colorNotes = notes.filter(n => {
        if (colorOption.id === 'default') {
          return !n.color || n.color === 'default';
        }
        return n.color === colorOption.id;
      });

      if (colorNotes.length > 0) {
        groups.push({
          colorId: colorOption.id,
          colorValue: colorOption.color,
          label: colorOption.label,
          notes: colorNotes.sort(
            (a, b) =>
              new Date(b.updated_at || b.created_at).getTime() -
              new Date(a.updated_at || a.created_at).getTime(),
          ),
        });
      }
    });

    return groups;
  };

  // Render a single grid card
  const renderGridCard = (note: SavedNote, index: number) => {
    const hasUrl = !!note.url;
    const hasImage = !!note.image_url;
    const noteColor = getNoteColor(note);

    return (
      <AnimatedCard
        key={note.id}
        index={index}
        onPress={() => openNote(note)}
        onLongPress={() => deleteNote(note.id)}
        style={[styles.gridCard, hasImage && styles.gridCardWithImage]}
        noteColor={noteColor}>
        {hasImage ? (
          <>
            <Image
              source={{uri: note.image_url}}
              style={styles.gridCardImage}
              resizeMode="cover"
            />
            <View style={styles.gridCardContent}>
              <Text style={styles.gridCardTitle} numberOfLines={1}>
                {note.title || 'Untitled'}
              </Text>
              <View style={styles.gridCardPreviewContainer}>
                <Text style={styles.gridCardPreview} numberOfLines={3}>
                  {getPreview(note)}
                </Text>
              </View>
              <View style={styles.gridCardFooter}>
                <Text style={styles.gridCardDate}>
                  {formatNoteTime(note.updated_at || note.created_at)}
                </Text>
                {hasUrl && (
                  <View style={styles.gridCardTag}>
                    <Text style={styles.gridCardTagText}>Link</Text>
                  </View>
                )}
                <Pressable
                  style={styles.gridCardColorBtn}
                  onPress={() => openColorPicker(note)}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                  <MaterialIcons
                    name="palette"
                    size={16}
                    color={noteColor || colors.muted}
                  />
                </Pressable>
              </View>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.gridCardTitle} numberOfLines={2}>
              {note.title || 'Untitled'}
            </Text>
            <View style={styles.gridCardPreviewContainer}>
              <Text style={styles.gridCardPreview} numberOfLines={7}>
                {getPreview(note)}
              </Text>
            </View>
            <View style={styles.gridCardFooter}>
              <Text style={styles.gridCardDate}>
                {formatNoteTime(note.updated_at || note.created_at)}
              </Text>
              {hasUrl && (
                <View style={styles.gridCardTag}>
                  <Text style={styles.gridCardTagText}>Link</Text>
                </View>
              )}
              <Pressable
                style={styles.gridCardColorBtn}
                onPress={() => openColorPicker(note)}
                hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                <MaterialIcons
                  name="palette"
                  size={16}
                  color={noteColor || colors.muted}
                />
              </Pressable>
            </View>
          </>
        )}
      </AnimatedCard>
    );
  };

  // Render masonry columns for a set of notes
  const renderMasonryColumns = (
    notes: SavedNote[],
    startIndex: number = 0,
    skipBottomPadding: boolean = false,
  ) => {
    const leftColumn: SavedNote[] = [];
    const rightColumn: SavedNote[] = [];
    let leftHeight = 0;
    let rightHeight = 0;

    const IMAGE_CARD_HEIGHT = 280;
    const TEXT_CARD_HEIGHT = 180;

    notes.forEach(note => {
      const cardHeight = note.image_url ? IMAGE_CARD_HEIGHT : TEXT_CARD_HEIGHT;
      if (leftHeight <= rightHeight) {
        leftColumn.push(note);
        leftHeight += cardHeight + CARD_GAP;
      } else {
        rightColumn.push(note);
        rightHeight += cardHeight + CARD_GAP;
      }
    });

    return (
      <View
        style={[
          styles.masonryContainer,
          skipBottomPadding && {paddingBottom: 0},
        ]}>
        <View style={[styles.masonryColumn, styles.masonryColumnLeft]}>
          {leftColumn.map((note, index) =>
            renderGridCard(note, startIndex + index * 2),
          )}
        </View>
        <View style={[styles.masonryColumn, styles.masonryColumnRight]}>
          {rightColumn.map((note, index) =>
            renderGridCard(note, startIndex + index * 2 + 1),
          )}
        </View>
      </View>
    );
  };

  // Render grid cards (Pinterest-style masonry layout)
  const renderGridCards = () => {
    if (filteredNotes.length === 0) return null;

    const sortedNotes = [...filteredNotes].sort(
      (a, b) =>
        new Date(b.updated_at || b.created_at).getTime() -
        new Date(a.updated_at || a.created_at).getTime(),
    );

    // Color grouping mode
    if (sortMode === 'color') {
      const colorGroups = groupNotesByColor(sortedNotes);
      let globalIndex = 0;

      return (
        <View style={{paddingBottom: 140}}>
          {colorGroups.map(group => {
            const groupStartIndex = globalIndex;
            globalIndex += group.notes.length;

            return (
              <View key={group.colorId}>
                <View style={styles.colorSectionHeader}>
                  <View
                    style={[
                      styles.colorSectionDot,
                      {
                        backgroundColor:
                          group.colorValue || theme.colors.muted + '40',
                        borderWidth: group.colorValue ? 0 : 1,
                        borderColor: theme.colors.muted,
                      },
                    ]}
                  />
                  <Text style={styles.colorSectionTitle}>{group.label}</Text>
                  <Text style={styles.colorSectionCount}>
                    ({group.notes.length})
                  </Text>
                </View>
                {renderMasonryColumns(group.notes, groupStartIndex, true)}
              </View>
            );
          })}
        </View>
      );
    }

    // Recent mode (default)
    return renderMasonryColumns(sortedNotes);
  };

  // Group notes by day for list view
  const groupNotesByDay = (notes: SavedNote[]) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const groups: {title: string; notes: SavedNote[]}[] = [
      {title: 'Today', notes: []},
      {title: 'Yesterday', notes: []},
      {title: 'This Week', notes: []},
      {title: 'Earlier', notes: []},
    ];

    notes.forEach(note => {
      const noteDate = new Date(note.updated_at || note.created_at);
      const noteDateOnly = new Date(
        noteDate.getFullYear(),
        noteDate.getMonth(),
        noteDate.getDate(),
      );

      if (noteDateOnly >= today) {
        groups[0].notes.push(note);
      } else if (noteDateOnly >= yesterday) {
        groups[1].notes.push(note);
      } else if (noteDateOnly >= weekAgo) {
        groups[2].notes.push(note);
      } else {
        groups[3].notes.push(note);
      }
    });

    return groups.filter(g => g.notes.length > 0);
  };

  // Render a single list card
  const renderListCard = (note: SavedNote, index: number) => {
    const hasUrl = !!note.url;
    const hasImage = !!note.image_url;
    const noteColor = getNoteColor(note);

    return (
      <AnimatedCard
        key={note.id}
        index={index}
        onPress={() => openNote(note)}
        onLongPress={() => deleteNote(note.id)}
        style={styles.listCard}
        noteColor={noteColor}>
        {hasImage ? (
          <Image
            source={{uri: note.image_url}}
            style={styles.listCardImage}
            resizeMode="contain"
          />
        ) : (
          <View style={styles.listCardIcon}>
            <MaterialIcons
              name={hasUrl ? 'link' : 'sticky-note-2'}
              size={22}
              color={theme.colors.primary}
            />
          </View>
        )}
        <View style={styles.listCardContent}>
          <Text style={styles.listCardTitle} numberOfLines={1}>
            {note.title || 'Untitled'}
          </Text>
          <Text style={styles.listCardPreview} numberOfLines={1}>
            {getPreview(note)}
          </Text>
          <Text style={styles.listCardDate}>
            {formatNoteTime(note.updated_at || note.created_at)}
          </Text>
        </View>
        <View style={styles.listCardActions}>
          <Pressable
            style={styles.listCardColorBtn}
            onPress={() => openColorPicker(note)}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
            <MaterialIcons
              name="palette"
              size={18}
              color={noteColor || colors.muted}
            />
          </Pressable>
          <MaterialIcons name="chevron-right" size={24} color={colors.muted} />
        </View>
      </AnimatedCard>
    );
  };

  // Render list cards with day or color sections
  const renderListCards = () => {
    if (filteredNotes.length === 0) return null;

    const sortedNotes = [...filteredNotes].sort(
      (a, b) =>
        new Date(b.updated_at || b.created_at).getTime() -
        new Date(a.updated_at || a.created_at).getTime(),
    );

    let globalIndex = 0;

    // Color grouping mode
    if (sortMode === 'color') {
      const colorGroups = groupNotesByColor(sortedNotes);

      return (
        <View style={styles.listContainer}>
          {colorGroups.map(group => (
            <View key={group.colorId}>
              <View style={styles.colorSectionHeader}>
                <View
                  style={[
                    styles.colorSectionDot,
                    {
                      backgroundColor:
                        group.colorValue || theme.colors.muted + '40',
                      borderWidth: group.colorValue ? 0 : 1,
                      borderColor: theme.colors.muted,
                    },
                  ]}
                />
                <Text style={styles.colorSectionTitle}>{group.label}</Text>
                <Text style={styles.colorSectionCount}>
                  ({group.notes.length})
                </Text>
              </View>
              <View style={styles.listSectionCards}>
                {group.notes.map(note => {
                  const cardIndex = globalIndex++;
                  return renderListCard(note, cardIndex);
                })}
              </View>
            </View>
          ))}
        </View>
      );
    }

    // Recent mode (default) - group by day
    const groupedNotes = groupNotesByDay(sortedNotes);

    return (
      <View style={styles.listContainer}>
        {groupedNotes.map(group => (
          <View key={group.title}>
            <Text style={styles.listSectionTitle}>{group.title}</Text>
            <View style={styles.listSectionCards}>
              {group.notes.map(note => {
                const cardIndex = globalIndex++;
                return renderListCard(note, cardIndex);
              })}
            </View>
          </View>
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.container}>
        <Animated.View
          style={[
            styles.header,
            {
              opacity: headerFadeAnim,
              transform: [{translateY: headerSlideAnim}],
            },
          ]}>
          <AppleTouchFeedback
            hapticStyle="impactLight"
            onPress={() => navigate('Home')}>
            <MaterialIcons
              name="arrow-back-ios"
              size={24}
              color={colors.foreground}
            />
          </AppleTouchFeedback>
          <Text style={styles.title}>My Notes</Text>
          <View style={styles.headerActions}>
            {notes.length > 0 && (
              <Pressable
                style={styles.exportBtn}
                onPress={() => exportAllNotes(notes)}>
                <MaterialIcons
                  name="ios-share"
                  size={20}
                  color={colors.buttonText1}
                />
              </Pressable>
            )}
            <Pressable
              style={[
                styles.sortToggle,
                sortMode === 'color' && styles.sortToggleActive,
              ]}
              onPress={toggleSortMode}>
              <MaterialIcons
                name="palette"
                size={20}
                color={
                  sortMode === 'color'
                    ? theme.colors.buttonText1
                    : colors.buttonText1
                }
              />
            </Pressable>
            <Pressable style={styles.viewToggle} onPress={toggleViewMode}>
              <MaterialIcons
                name={viewMode === 'grid' ? 'view-list' : 'grid-view'}
                size={22}
                color={colors.buttonText1}
              />
            </Pressable>
          </View>
        </Animated.View>

        <Animated.View
          style={[
            styles.searchContainer,
            {
              opacity: searchFadeAnim,
              transform: [{scale: searchScaleAnim}],
            },
          ]}>
          <Animated.View
            style={[
              styles.searchInputWrapper,
              {borderColor: searchBorderColor},
            ]}>
            <MaterialIcons
              name="search"
              size={22}
              color={isSearchFocused ? theme.colors.primary : colors.muted}
              style={styles.searchIcon}
            />
            <TextInput
              placeholder="Search notes..."
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setIsSearchFocused(false)}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                style={styles.searchClearBtn}
                onPress={() => {
                  h('impactLight');
                  setSearchQuery('');
                }}>
                <MaterialIcons name="close" size={20} color={colors.muted} />
              </TouchableOpacity>
            )}
          </Animated.View>
        </Animated.View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <View style={styles.loadingDots}>
              {[0, 1, 2].map(i => (
                <Animated.View
                  key={i}
                  style={[styles.loadingDot, {opacity: headerFadeAnim}]}
                />
              ))}
            </View>
          </View>
        ) : filteredNotes.length === 0 ? (
          <Animated.View
            style={[
              styles.emptyContainer,
              {
                opacity: emptyStateAnim,
                transform: [
                  {
                    scale: emptyStateAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.9, 1],
                    }),
                  },
                ],
              },
            ]}>
            <View style={styles.emptyIconContainer}>
              <MaterialIcons
                name="note-add"
                size={56}
                color={theme.colors.primary}
              />
            </View>
            <Text style={styles.emptyTitle}>
              {searchQuery ? 'No Results' : 'No Notes Yet'}
            </Text>
            <Text style={styles.emptyText}>
              {searchQuery
                ? 'Try a different search term'
                : 'Tap the "+" button to create your first note\nor save text from the Web Browser'}
            </Text>
          </Animated.View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }>
            {/* Stats Row */}
            <Animated.View style={[styles.statsRow, {opacity: searchFadeAnim}]}>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{filteredNotes.length}</Text>
                <Text style={styles.statLabel}>Total Notes</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>
                  {filteredNotes.filter(n => n.url).length}
                </Text>
                <Text style={styles.statLabel}>Saved Links</Text>
              </View>
            </Animated.View>

            {/* Section Header */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                {searchQuery ? 'Search Results' : 'Recent Notes'}
              </Text>
            </View>

            {/* Cards - Grid or List */}
            {viewMode === 'grid' ? renderGridCards() : renderListCards()}
          </ScrollView>
        )}
      </View>

      <Animated.View
        style={[styles.addButton, {transform: [{scale: fabScaleAnim}]}]}>
        <Pressable
          onPress={() => {
            h('impactMedium');
            navigate('SaveNote');
          }}
          onPressIn={handleFabPressIn}
          onPressOut={handleFabPressOut}>
          <MaterialIcons name="add" size={32} color="#FFFFFF" />
        </Pressable>
      </Animated.View>

      {/* Color Picker Modal */}
      <ColorPickerModal
        visible={colorModalVisible}
        onClose={() => {
          setColorModalVisible(false);
          setSelectedNoteForColor(null);
        }}
        onSelectColor={handleColorSelect}
        currentColor={selectedNoteForColor?.color}
        theme={theme}
      />
    </SafeAreaView>
  );
}


//////////////////////////


// import React, {useEffect, useState, useRef, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   TouchableOpacity,
//   Alert,
//   TextInput,
//   ScrollView,
//   Animated,
//   Easing,
//   Pressable,
//   RefreshControl,
//   Modal,
//   Image,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import LinearGradient from 'react-native-linear-gradient';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useUUID} from '../context/UUIDContext';
// import {
//   useSavedNotes,
//   useDeleteNote,
//   useUpdateNote,
//   SavedNote,
// } from '../hooks/useSavedNotes';
// import {useExportNotes} from '../hooks/useExportNotes';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useAppTheme, Theme} from '../context/ThemeContext';
// import {tokens} from '../styles/tokens/tokens';
// import {fontScale, moderateScale} from '../utils/scale';

// const CARD_GAP = 10;
// const NOTES_VIEW_MODE_KEY = 'notes_view_mode';

// // Color options for notes
// const NOTE_COLORS = [
//   {id: 'green', color: '#34C759', label: 'Green'},
//   {id: 'red', color: '#FF3B30', label: 'Red'},
//   {id: 'blue', color: '#007AFF', label: 'Blue'},
//   {id: 'purple', color: '#AF52DE', label: 'Purple'},
//   {id: 'orange', color: '#FF9500', label: 'Orange'},
//   {id: 'default', color: null, label: 'Default'},
// ];

// // Animated card component
// const AnimatedCard = ({
//   children,
//   onPress,
//   onLongPress,
//   style,
//   index,
//   noteColor,
// }: {
//   children: React.ReactNode;
//   onPress: () => void;
//   onLongPress?: () => void;
//   style?: any;
//   index: number;
//   noteColor?: string | null;
// }) => {
//   const scaleAnim = useRef(new Animated.Value(1)).current;
//   const fadeAnim = useRef(new Animated.Value(0)).current;
//   const slideAnim = useRef(new Animated.Value(30)).current;

//   useEffect(() => {
//     // Fast stagger: 20ms per card, max 100ms delay for snappy feel
//     const delay = Math.min(index * 20, 100);
//     Animated.parallel([
//       Animated.timing(fadeAnim, {
//         toValue: 1,
//         duration: 200,
//         delay,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//       Animated.timing(slideAnim, {
//         toValue: 0,
//         duration: 200,
//         delay,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//     ]).start();
//   }, [index, fadeAnim, slideAnim]);

//   const handlePressIn = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 0.95,
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
//       onLongPress={onLongPress}
//       onPressIn={handlePressIn}
//       onPressOut={handlePressOut}>
//       <Animated.View
//         style={[
//           style,
//           {
//             opacity: fadeAnim,
//             transform: [{scale: scaleAnim}, {translateY: slideAnim}],
//           },
//           noteColor && {
//             borderLeftWidth: 4,
//             borderLeftColor: noteColor,
//           },
//         ]}>
//         {children}
//       </Animated.View>
//     </Pressable>
//   );
// };

// // Color Picker Modal Component
// const ColorPickerModal = ({
//   visible,
//   onClose,
//   onSelectColor,
//   currentColor,
//   theme,
// }: {
//   visible: boolean;
//   onClose: () => void;
//   onSelectColor: (colorId: string) => void;
//   currentColor?: string | null;
//   theme: any;
// }) => {
//   const slideAnim = useRef(new Animated.Value(300)).current;
//   const backdropAnim = useRef(new Animated.Value(0)).current;

//   useEffect(() => {
//     if (visible) {
//       Animated.parallel([
//         Animated.spring(slideAnim, {
//           toValue: 0,
//           useNativeDriver: true,
//           speed: 14,
//           bounciness: 4,
//         }),
//         Animated.timing(backdropAnim, {
//           toValue: 1,
//           duration: 200,
//           useNativeDriver: true,
//         }),
//       ]).start();
//     } else {
//       Animated.parallel([
//         Animated.timing(slideAnim, {
//           toValue: 300,
//           duration: 200,
//           useNativeDriver: true,
//         }),
//         Animated.timing(backdropAnim, {
//           toValue: 0,
//           duration: 200,
//           useNativeDriver: true,
//         }),
//       ]).start();
//     }
//   }, [visible, slideAnim, backdropAnim]);

//   const modalStyles = StyleSheet.create({
//     backdrop: {
//       flex: 1,
//       backgroundColor: 'rgba(0,0,0,0.5)',
//       justifyContent: 'flex-end',
//     },
//     modalContainer: {
//       backgroundColor: theme.colors.surface,
//       borderTopLeftRadius: 24,
//       borderTopRightRadius: 24,
//       paddingTop: 12,
//       paddingBottom: 40,
//       paddingHorizontal: 24,
//     },
//     handle: {
//       width: 40,
//       height: 4,
//       backgroundColor: theme.colors.muted + '50',
//       borderRadius: 2,
//       alignSelf: 'center',
//       marginBottom: 20,
//     },
//     title: {
//       fontSize: 20,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginBottom: 20,
//       textAlign: 'center',
//     },
//     colorsContainer: {
//       flexDirection: 'row',
//       justifyContent: 'center',
//       flexWrap: 'wrap',
//       gap: 16,
//     },
//     colorOption: {
//       alignItems: 'center',
//       gap: 8,
//     },
//     colorDot: {
//       width: 48,
//       height: 48,
//       borderRadius: 24,
//       justifyContent: 'center',
//       alignItems: 'center',
//       borderWidth: 3,
//       borderColor: 'transparent',
//     },
//     colorDotSelected: {
//       borderColor: theme.colors.foreground,
//     },
//     colorDotDefault: {
//       backgroundColor: theme.colors.surface,
//       borderWidth: 2,
//       borderColor: theme.colors.muted + '40',
//     },
//     colorLabel: {
//       fontSize: 12,
//       color: theme.colors.muted,
//       fontWeight: '500',
//     },
//     cancelBtn: {
//       marginTop: 24,
//       paddingVertical: 14,
//       borderRadius: 12,
//       backgroundColor: theme.colors.muted + '20',
//       alignItems: 'center',
//     },
//     cancelBtnText: {
//       fontSize: 16,
//       fontWeight: '600',
//       color: theme.colors.foreground,
//     },
//   });

//   return (
//     <Modal visible={visible} transparent animationType="none">
//       <Animated.View style={[modalStyles.backdrop, {opacity: backdropAnim}]}>
//         <Pressable style={{flex: 1}} onPress={onClose} />
//         <Animated.View
//           style={[
//             modalStyles.modalContainer,
//             {transform: [{translateY: slideAnim}]},
//           ]}>
//           <View style={modalStyles.handle} />
//           <Text style={modalStyles.title}>Choose Color</Text>
//           <View style={modalStyles.colorsContainer}>
//             {NOTE_COLORS.map(colorOption => {
//               const isSelected = currentColor === colorOption.id;
//               const isDefault = colorOption.id === 'default';

//               return (
//                 <Pressable
//                   key={colorOption.id}
//                   style={modalStyles.colorOption}
//                   onPress={() => {
//                     ReactNativeHapticFeedback.trigger('impactLight', {
//                       enableVibrateFallback: true,
//                       ignoreAndroidSystemSettings: false,
//                     });
//                     onSelectColor(colorOption.id);
//                   }}>
//                   <View
//                     style={[
//                       modalStyles.colorDot,
//                       isDefault
//                         ? modalStyles.colorDotDefault
//                         : {backgroundColor: colorOption.color || undefined},
//                       isSelected && modalStyles.colorDotSelected,
//                     ]}>
//                     {isSelected && (
//                       <MaterialIcons
//                         name="check"
//                         size={24}
//                         color={isDefault ? theme.colors.foreground : '#FFFFFF'}
//                       />
//                     )}
//                   </View>
//                   <Text style={modalStyles.colorLabel}>
//                     {colorOption.label}
//                   </Text>
//                 </Pressable>
//               );
//             })}
//           </View>
//           <Pressable style={modalStyles.cancelBtn} onPress={onClose}>
//             <Text style={modalStyles.cancelBtnText}>Cancel</Text>
//           </Pressable>
//         </Animated.View>
//       </Animated.View>
//     </Modal>
//   );
// };

// // SavedNote type is imported from useSavedNotes hook

// type Props = {
//   navigate: (screen: any, params?: any) => void;
// };

// type ViewMode = 'grid' | 'list';
// type SortMode = 'recent' | 'color';

// // Stylesheet factory - moved outside component for performance
// const createStyles = (theme: Theme) => {
//   const colors = theme.colors;
//   return StyleSheet.create({
//     screen: {
//       flex: 1,
//       paddingTop: 55,
//     },
//     container: {
//       flex: 1,
//       paddingHorizontal: 16,
//     },
//     header: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       paddingVertical: 16,
//       gap: 12,
//     },
//     title: {
//       fontSize: 28,
//       fontWeight: '700',
//       color: colors.foreground,
//       flex: 1,
//     },
//     headerActions: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 8,
//     },
//     viewToggle: {
//       width: 40,
//       height: 40,
//       borderRadius: 8,
//       backgroundColor: theme.colors.surface3,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     sortToggle: {
//       width: 40,
//       height: 40,
//       borderRadius: 8,
//       backgroundColor: theme.colors.surface,
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     sortToggleActive: {
//       backgroundColor: theme.colors.button1 + '20',
//     },
//     exportBtn: {
//       width: 40,
//       height: 40,
//       borderRadius: 8,
//       backgroundColor: 'blue',
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     searchContainer: {
//       marginBottom: 20,
//     },
//     searchInputWrapper: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: theme.colors.surface,
//       borderRadius: 16,
//       paddingHorizontal: 16,
//       borderWidth: 1.5,
//       overflow: 'hidden',
//     },
//     searchIcon: {
//       marginRight: 12,
//     },
//     searchInput: {
//       flex: 1,
//       paddingVertical: 14,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     searchClearBtn: {
//       padding: 4,
//     },
//     statsRow: {
//       flexDirection: 'row',
//       marginBottom: 20,
//       gap: 10,
//     },
//     statCard: {
//       flex: 1,
//       // backgroundColor: '#ff6806',
//       backgroundColor: theme.colors.button1,
//       borderRadius: 16,
//       padding: 16,
//       alignItems: 'center',
//     },
//     statNumber: {
//       fontSize: 28,
//       color: theme.colors.buttonText1,
//       fontWeight: '700',
//     },
//     statLabel: {
//       fontSize: 16,
//       color: theme.colors.buttonText1,
//       marginTop: 4,
//       // textTransform: 'uppercase',
//       letterSpacing: 0.5,
//       fontWeight: '700',
//     },
//     sectionHeader: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       marginBottom: 16,
//       marginTop: 8,
//     },
//     sectionTitle: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: colors.foreground,
//     },
//     // Grid cards container
//     // Pinterest-style masonry container
//     masonryContainer: {
//       flexDirection: 'row',
//       paddingBottom: 140,
//     },
//     masonryColumn: {
//       flex: 1,
//       gap: CARD_GAP,
//     },
//     masonryColumnLeft: {
//       marginRight: CARD_GAP / 2,
//     },
//     masonryColumnRight: {
//       marginLeft: CARD_GAP / 2,
//     },
//     // List cards container
//     listContainer: {
//       gap: 10,
//       paddingBottom: 140,
//     },
//     // Masonry grid card (auto-height for Pinterest layout)
//     gridCard: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       paddingVertical: 16,
//       paddingHorizontal: 16,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 4},
//       shadowOpacity: 0.08,
//       shadowRadius: 12,
//       elevation: 4,
//       flexDirection: 'column',
//       overflow: 'hidden',
//     },
//     // Grid card without padding for image cards
//     gridCardWithImage: {
//       paddingVertical: 0,
//       paddingHorizontal: 0,
//     },
//     gridCardHeader: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'flex-start',
//       // marginBottom: 10,
//     },
//     gridCardIcon: {
//       width: 36,
//       height: 36,
//       borderRadius: 10,
//       backgroundColor: theme.colors.primary + '15',
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     gridCardColorBtn: {
//       width: 28,
//       height: 28,
//       borderRadius: 14,
//       justifyContent: 'center',
//       alignItems: 'center',
//       backgroundColor: theme.colors.muted + '20',
//     },
//     gridCardTitle: {
//       fontSize: 18,
//       fontWeight: '700',
//       color: colors.foreground,
//       marginBottom: 8,
//       lineHeight: 22,
//     },
//     gridCardPreviewContainer: {
//       flex: 1,
//       overflow: 'hidden',
//     },
//     gridCardPreview: {
//       fontSize: 14,
//       color: colors.muted,
//       lineHeight: 18,
//       fontWeight: '500',
//     },
//     gridCardFooter: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'space-between',
//       marginTop: 8,
//       gap: 8,
//     },
//     gridCardDate: {
//       fontSize: 11,
//       color: colors.muted,
//       fontWeight: '500',
//     },
//     gridCardTag: {
//       backgroundColor: theme.colors.primary + '15',
//       paddingHorizontal: 8,
//       paddingVertical: 3,
//       borderRadius: 8,
//     },
//     gridCardTagText: {
//       fontSize: 10,
//       color: theme.colors.primary,
//       fontWeight: '600',
//     },
//     // Full-width image at top of card (edge to edge)
//     gridCardImage: {
//       width: '100%',
//       height: 150,
//       borderTopLeftRadius: tokens.borderRadius.xxl,
//       borderTopRightRadius: tokens.borderRadius.xxl,
//       borderBottomLeftRadius: 0,
//       borderBottomRightRadius: 0,
//     },
//     // Content wrapper with padding for cards with images
//     gridCardContent: {
//       flex: 1,
//       paddingHorizontal: 16,
//       paddingVertical: 20,
//       flexDirection: 'column',
//     },
//     listCardImage: {
//       width: 44,
//       height: 44,
//       borderRadius: 12,
//     },
//     // List card
//     listCard: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       borderRadius: 14,
//       padding: 14,
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 12,
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 2},
//       shadowOpacity: 0.05,
//       shadowRadius: 8,
//       elevation: 2,
//     },
//     listCardIcon: {
//       width: 44,
//       height: 44,
//       borderRadius: 12,
//       backgroundColor: theme.colors.primary + '15',
//       justifyContent: 'center',
//       alignItems: 'center',
//     },
//     listCardContent: {
//       flex: 1,
//     },
//     listCardTitle: {
//       fontSize: 16,
//       fontWeight: '600',
//       color: colors.foreground,
//       marginBottom: 4,
//     },
//     listCardPreview: {
//       fontSize: 14,
//       fontWeight: '500',
//       color: colors.muted,
//       lineHeight: 18,
//       marginBottom: 4,
//     },
//     listCardDate: {
//       fontSize: 12,
//       color: colors.muted,
//     },
//     listCardActions: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 8,
//     },
//     listCardColorBtn: {
//       width: 32,
//       height: 32,
//       borderRadius: 16,
//       justifyContent: 'center',
//       alignItems: 'center',
//       backgroundColor: theme.colors.muted + '20',
//     },
//     listSectionTitle: {
//       fontSize: 14,
//       fontWeight: '600',
//       color: colors.muted,
//       marginTop: 16,
//       marginBottom: 10,
//       textTransform: 'uppercase',
//       letterSpacing: 0.5,
//     },
//     listSectionCards: {
//       gap: 6,
//     },
//     colorSectionHeader: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 10,
//       marginTop: 22,
//       marginBottom: 10,
//     },
//     colorSectionDot: {
//       width: 14,
//       height: 14,
//       borderRadius: 7,
//     },
//     colorSectionTitle: {
//       fontSize: 16,
//       fontWeight: '700',
//       color: colors.foreground,
//     },
//     colorSectionCount: {
//       fontSize: 13,
//       color: colors.muted,
//       fontWeight: '500',
//     },
//     emptyContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//       paddingTop: 60,
//     },
//     emptyIconContainer: {
//       width: 120,
//       height: 120,
//       borderRadius: 60,
//       backgroundColor: theme.colors.primary + '10',
//       justifyContent: 'center',
//       alignItems: 'center',
//       marginBottom: 24,
//     },
//     emptyTitle: {
//       fontSize: 22,
//       fontWeight: '700',
//       color: colors.foreground,
//       marginBottom: 10,
//     },
//     emptyText: {
//       fontSize: 15,
//       color: colors.muted,
//       textAlign: 'center',
//       lineHeight: 22,
//       paddingHorizontal: 40,
//     },
//     addButton: {
//       position: 'absolute',
//       bottom: 100,
//       right: 20,
//       width: 54,
//       height: 54,
//       borderRadius: 32,
//       borderWidth: 1,
//       borderColor: theme.colors.foreground,
//       backgroundColor: 'rgba(54, 54, 54, 0.52)',
//       alignItems: 'center',
//       justifyContent: 'center',
//     },

//     addButtonShadow: {
//       shadowColor: theme.colors.primary,
//       shadowOffset: {width: 0, height: 8},
//       shadowOpacity: 0.4,
//       shadowRadius: 16,
//       elevation: 12,
//     },
//     loadingContainer: {
//       flex: 1,
//       justifyContent: 'center',
//       alignItems: 'center',
//       paddingTop: 100,
//     },
//     loadingDots: {
//       flexDirection: 'row',
//       gap: 8,
//     },
//     loadingDot: {
//       width: 10,
//       height: 10,
//       borderRadius: 5,
//       backgroundColor: theme.colors.primary,
//     },
//   });
// };

// export default function NotesScreen({navigate}: Props) {
//   const userId = useUUID();
//   const {theme} = useAppTheme();
//   const colors = theme.colors;
//   const styles = useMemo(() => createStyles(theme), [theme]);

//   // TanStack Query hooks
//   const {data: notes = [], isLoading, refetch} = useSavedNotes(userId || '');
//   const deleteNoteMutation = useDeleteNote();
//   const updateNoteMutation = useUpdateNote();
//   const {exportAllNotes} = useExportNotes();

//   const [refreshing, setRefreshing] = useState(false);
//   const [searchQuery, setSearchQuery] = useState('');
//   const [viewMode, setViewMode] = useState<ViewMode>('list');
//   const [sortMode, setSortMode] = useState<SortMode>('recent');
//   const [colorModalVisible, setColorModalVisible] = useState(false);
//   const [selectedNoteForColor, setSelectedNoteForColor] =
//     useState<SavedNote | null>(null);

//   // Animation refs
//   const headerFadeAnim = useRef(new Animated.Value(0)).current;
//   const headerSlideAnim = useRef(new Animated.Value(-20)).current;
//   const searchFadeAnim = useRef(new Animated.Value(0)).current;
//   const searchScaleAnim = useRef(new Animated.Value(0.95)).current;
//   const fabScaleAnim = useRef(new Animated.Value(0)).current;
//   const emptyStateAnim = useRef(new Animated.Value(0)).current;
//   const searchFocusAnim = useRef(new Animated.Value(0)).current;
//   const [isSearchFocused, setIsSearchFocused] = useState(false);

//   // Load saved view mode on mount
//   useEffect(() => {
//     AsyncStorage.getItem(NOTES_VIEW_MODE_KEY).then(saved => {
//       if (saved === 'grid' || saved === 'list') {
//         setViewMode(saved);
//       }
//     });
//   }, []);

//   // Entrance animations - run all in parallel for instant feel
//   useEffect(() => {
//     Animated.parallel([
//       Animated.timing(headerFadeAnim, {
//         toValue: 1,
//         duration: 150,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//       Animated.timing(headerSlideAnim, {
//         toValue: 0,
//         duration: 150,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//       Animated.timing(searchFadeAnim, {
//         toValue: 1,
//         duration: 150,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//       Animated.timing(searchScaleAnim, {
//         toValue: 1,
//         duration: 150,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//       Animated.timing(fabScaleAnim, {
//         toValue: 1,
//         duration: 150,
//         easing: Easing.out(Easing.cubic),
//         useNativeDriver: true,
//       }),
//     ]).start();
//   }, []);

//   // Empty state animation
//   useEffect(() => {
//     if (!isLoading && notes.length === 0) {
//       Animated.spring(emptyStateAnim, {
//         toValue: 1,
//         useNativeDriver: true,
//         speed: 8,
//         bounciness: 10,
//       }).start();
//     }
//   }, [isLoading, notes.length]);

//   // Search focus animation
//   useEffect(() => {
//     Animated.timing(searchFocusAnim, {
//       toValue: isSearchFocused ? 1 : 0,
//       duration: 200,
//       easing: Easing.out(Easing.cubic),
//       useNativeDriver: false,
//     }).start();
//   }, [isSearchFocused]);

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

//   const onRefresh = async () => {
//     setRefreshing(true);
//     await refetch();
//     setRefreshing(false);
//   };

//   const deleteNote = async (id: string) => {
//     h('impactMedium');
//     Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
//       {text: 'Cancel', style: 'cancel'},
//       {
//         text: 'Delete',
//         style: 'destructive',
//         onPress: () => {
//           deleteNoteMutation.mutate(
//             {noteId: id, userId: userId || ''},
//             {
//               onError: () => {
//                 Alert.alert('Error', 'Failed to delete note');
//               },
//             },
//           );
//         },
//       },
//     ]);
//   };

//   const updateNoteColor = (noteId: string, colorId: string) => {
//     const newColor = colorId === 'default' ? null : colorId;
//     updateNoteMutation.mutate({
//       noteId,
//       userId: userId || '',
//       color: newColor,
//     });
//   };

//   const openColorPicker = (note: SavedNote) => {
//     h('impactLight');
//     setSelectedNoteForColor(note);
//     setColorModalVisible(true);
//   };

//   const handleColorSelect = (colorId: string) => {
//     if (selectedNoteForColor) {
//       updateNoteColor(selectedNoteForColor.id, colorId);
//     }
//     setColorModalVisible(false);
//     setSelectedNoteForColor(null);
//   };

//   const filteredNotes = notes.filter(note => {
//     const query = searchQuery.toLowerCase();
//     return (
//       note.title?.toLowerCase().includes(query) ||
//       note.content?.toLowerCase().includes(query) ||
//       note.url?.toLowerCase().includes(query)
//     );
//   });

//   // Interpolate search border color based on focus
//   const searchBorderColor = searchFocusAnim.interpolate({
//     inputRange: [0, 1],
//     outputRange: [theme.colors.inputBorder, theme.colors.primary],
//   });

//   const getNoteColor = (note: SavedNote) => {
//     if (!note.color) return null;
//     const colorOption = NOTE_COLORS.find(c => c.id === note.color);
//     return colorOption?.color || null;
//   };

//   if (!userId) return null;

//   // Format time
//   const formatNoteTime = (dateStr: string) => {
//     const date = new Date(dateStr);
//     const now = new Date();
//     const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//     const yesterday = new Date(today);
//     yesterday.setDate(yesterday.getDate() - 1);

//     const noteDate = new Date(
//       date.getFullYear(),
//       date.getMonth(),
//       date.getDate(),
//     );

//     if (noteDate >= today) {
//       return date.toLocaleTimeString('en-US', {
//         hour: 'numeric',
//         minute: '2-digit',
//         hour12: true,
//       });
//     }
//     if (noteDate >= yesterday) {
//       return 'Yesterday';
//     }
//     return date.toLocaleDateString('en-US', {
//       month: 'short',
//       day: 'numeric',
//     });
//   };

//   const openNote = (note: SavedNote) => {
//     h('impactLight');
//     navigate('NoteDetail', {note});
//   };

//   const getPreview = (note: SavedNote) => {
//     if (note.content) {
//       return note.content.split('\n')[0].substring(0, 100);
//     }
//     if (note.url) {
//       return note.url;
//     }
//     return '';
//   };

//   // FAB press animation
//   const handleFabPressIn = () => {
//     Animated.spring(fabScaleAnim, {
//       toValue: 0.9,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   const handleFabPressOut = () => {
//     Animated.spring(fabScaleAnim, {
//       toValue: 1,
//       useNativeDriver: true,
//       speed: 50,
//       bounciness: 4,
//     }).start();
//   };

//   const toggleViewMode = () => {
//     h('impactLight');
//     setViewMode(prev => {
//       const newMode = prev === 'grid' ? 'list' : 'grid';
//       AsyncStorage.setItem(NOTES_VIEW_MODE_KEY, newMode);
//       return newMode;
//     });
//   };

//   const toggleSortMode = () => {
//     h('impactLight');
//     setSortMode(prev => (prev === 'recent' ? 'color' : 'recent'));
//   };

//   // Group notes by color
//   const groupNotesByColor = (notes: SavedNote[]) => {
//     const colorOrder = NOTE_COLORS.map(c => c.id);
//     const groups: {
//       colorId: string;
//       colorValue: string | null;
//       label: string;
//       notes: SavedNote[];
//     }[] = [];

//     // Create groups for each color that has notes
//     NOTE_COLORS.forEach(colorOption => {
//       const colorNotes = notes.filter(n => {
//         if (colorOption.id === 'default') {
//           return !n.color || n.color === 'default';
//         }
//         return n.color === colorOption.id;
//       });

//       if (colorNotes.length > 0) {
//         groups.push({
//           colorId: colorOption.id,
//           colorValue: colorOption.color,
//           label: colorOption.label,
//           notes: colorNotes.sort(
//             (a, b) =>
//               new Date(b.updated_at || b.created_at).getTime() -
//               new Date(a.updated_at || a.created_at).getTime(),
//           ),
//         });
//       }
//     });

//     return groups;
//   };

//   // Render a single grid card
//   const renderGridCard = (note: SavedNote, index: number) => {
//     const hasUrl = !!note.url;
//     const hasImage = !!note.image_url;
//     const noteColor = getNoteColor(note);

//     return (
//       <AnimatedCard
//         key={note.id}
//         index={index}
//         onPress={() => openNote(note)}
//         onLongPress={() => deleteNote(note.id)}
//         style={[styles.gridCard, hasImage && styles.gridCardWithImage]}
//         noteColor={noteColor}>
//         {hasImage ? (
//           <>
//             <Image
//               source={{uri: note.image_url}}
//               style={styles.gridCardImage}
//               resizeMode="cover"
//             />
//             <View style={styles.gridCardContent}>
//               <Text style={styles.gridCardTitle} numberOfLines={1}>
//                 {note.title || 'Untitled'}
//               </Text>
//               <View style={styles.gridCardPreviewContainer}>
//                 <Text style={styles.gridCardPreview} numberOfLines={3}>
//                   {getPreview(note)}
//                 </Text>
//               </View>
//               <View style={styles.gridCardFooter}>
//                 <Text style={styles.gridCardDate}>
//                   {formatNoteTime(note.updated_at || note.created_at)}
//                 </Text>
//                 {hasUrl && (
//                   <View style={styles.gridCardTag}>
//                     <Text style={styles.gridCardTagText}>Link</Text>
//                   </View>
//                 )}
//                 <Pressable
//                   style={styles.gridCardColorBtn}
//                   onPress={() => openColorPicker(note)}
//                   hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
//                   <MaterialIcons
//                     name="palette"
//                     size={16}
//                     color={noteColor || colors.muted}
//                   />
//                 </Pressable>
//               </View>
//             </View>
//           </>
//         ) : (
//           <>
//             <Text style={styles.gridCardTitle} numberOfLines={2}>
//               {note.title || 'Untitled'}
//             </Text>
//             <View style={styles.gridCardPreviewContainer}>
//               <Text style={styles.gridCardPreview} numberOfLines={7}>
//                 {getPreview(note)}
//               </Text>
//             </View>
//             <View style={styles.gridCardFooter}>
//               <Text style={styles.gridCardDate}>
//                 {formatNoteTime(note.updated_at || note.created_at)}
//               </Text>
//               {hasUrl && (
//                 <View style={styles.gridCardTag}>
//                   <Text style={styles.gridCardTagText}>Link</Text>
//                 </View>
//               )}
//               <Pressable
//                 style={styles.gridCardColorBtn}
//                 onPress={() => openColorPicker(note)}
//                 hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
//                 <MaterialIcons
//                   name="palette"
//                   size={16}
//                   color={noteColor || colors.muted}
//                 />
//               </Pressable>
//             </View>
//           </>
//         )}
//       </AnimatedCard>
//     );
//   };

//   // Render masonry columns for a set of notes
//   const renderMasonryColumns = (
//     notes: SavedNote[],
//     startIndex: number = 0,
//     skipBottomPadding: boolean = false,
//   ) => {
//     const leftColumn: SavedNote[] = [];
//     const rightColumn: SavedNote[] = [];
//     let leftHeight = 0;
//     let rightHeight = 0;

//     const IMAGE_CARD_HEIGHT = 280;
//     const TEXT_CARD_HEIGHT = 180;

//     notes.forEach(note => {
//       const cardHeight = note.image_url ? IMAGE_CARD_HEIGHT : TEXT_CARD_HEIGHT;
//       if (leftHeight <= rightHeight) {
//         leftColumn.push(note);
//         leftHeight += cardHeight + CARD_GAP;
//       } else {
//         rightColumn.push(note);
//         rightHeight += cardHeight + CARD_GAP;
//       }
//     });

//     return (
//       <View
//         style={[
//           styles.masonryContainer,
//           skipBottomPadding && {paddingBottom: 0},
//         ]}>
//         <View style={[styles.masonryColumn, styles.masonryColumnLeft]}>
//           {leftColumn.map((note, index) =>
//             renderGridCard(note, startIndex + index * 2),
//           )}
//         </View>
//         <View style={[styles.masonryColumn, styles.masonryColumnRight]}>
//           {rightColumn.map((note, index) =>
//             renderGridCard(note, startIndex + index * 2 + 1),
//           )}
//         </View>
//       </View>
//     );
//   };

//   // Render grid cards (Pinterest-style masonry layout)
//   const renderGridCards = () => {
//     if (filteredNotes.length === 0) return null;

//     const sortedNotes = [...filteredNotes].sort(
//       (a, b) =>
//         new Date(b.updated_at || b.created_at).getTime() -
//         new Date(a.updated_at || a.created_at).getTime(),
//     );

//     // Color grouping mode
//     if (sortMode === 'color') {
//       const colorGroups = groupNotesByColor(sortedNotes);
//       let globalIndex = 0;

//       return (
//         <View style={{paddingBottom: 140}}>
//           {colorGroups.map(group => {
//             const groupStartIndex = globalIndex;
//             globalIndex += group.notes.length;

//             return (
//               <View key={group.colorId}>
//                 <View style={styles.colorSectionHeader}>
//                   <View
//                     style={[
//                       styles.colorSectionDot,
//                       {
//                         backgroundColor:
//                           group.colorValue || theme.colors.muted + '40',
//                         borderWidth: group.colorValue ? 0 : 1,
//                         borderColor: theme.colors.muted,
//                       },
//                     ]}
//                   />
//                   <Text style={styles.colorSectionTitle}>{group.label}</Text>
//                   <Text style={styles.colorSectionCount}>
//                     ({group.notes.length})
//                   </Text>
//                 </View>
//                 {renderMasonryColumns(group.notes, groupStartIndex, true)}
//               </View>
//             );
//           })}
//         </View>
//       );
//     }

//     // Recent mode (default)
//     return renderMasonryColumns(sortedNotes);
//   };

//   // Group notes by day for list view
//   const groupNotesByDay = (notes: SavedNote[]) => {
//     const now = new Date();
//     const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//     const yesterday = new Date(today);
//     yesterday.setDate(yesterday.getDate() - 1);
//     const weekAgo = new Date(today);
//     weekAgo.setDate(weekAgo.getDate() - 7);

//     const groups: {title: string; notes: SavedNote[]}[] = [
//       {title: 'Today', notes: []},
//       {title: 'Yesterday', notes: []},
//       {title: 'This Week', notes: []},
//       {title: 'Earlier', notes: []},
//     ];

//     notes.forEach(note => {
//       const noteDate = new Date(note.updated_at || note.created_at);
//       const noteDateOnly = new Date(
//         noteDate.getFullYear(),
//         noteDate.getMonth(),
//         noteDate.getDate(),
//       );

//       if (noteDateOnly >= today) {
//         groups[0].notes.push(note);
//       } else if (noteDateOnly >= yesterday) {
//         groups[1].notes.push(note);
//       } else if (noteDateOnly >= weekAgo) {
//         groups[2].notes.push(note);
//       } else {
//         groups[3].notes.push(note);
//       }
//     });

//     return groups.filter(g => g.notes.length > 0);
//   };

//   // Render a single list card
//   const renderListCard = (note: SavedNote, index: number) => {
//     const hasUrl = !!note.url;
//     const hasImage = !!note.image_url;
//     const noteColor = getNoteColor(note);

//     return (
//       <AnimatedCard
//         key={note.id}
//         index={index}
//         onPress={() => openNote(note)}
//         onLongPress={() => deleteNote(note.id)}
//         style={styles.listCard}
//         noteColor={noteColor}>
//         {hasImage ? (
//           <Image
//             source={{uri: note.image_url}}
//             style={styles.listCardImage}
//             resizeMode="cover"
//           />
//         ) : (
//           <View style={styles.listCardIcon}>
//             <MaterialIcons
//               name={hasUrl ? 'link' : 'sticky-note-2'}
//               size={22}
//               color={theme.colors.primary}
//             />
//           </View>
//         )}
//         <View style={styles.listCardContent}>
//           <Text style={styles.listCardTitle} numberOfLines={1}>
//             {note.title || 'Untitled'}
//           </Text>
//           <Text style={styles.listCardPreview} numberOfLines={1}>
//             {getPreview(note)}
//           </Text>
//           <Text style={styles.listCardDate}>
//             {formatNoteTime(note.updated_at || note.created_at)}
//           </Text>
//         </View>
//         <View style={styles.listCardActions}>
//           <Pressable
//             style={styles.listCardColorBtn}
//             onPress={() => openColorPicker(note)}
//             hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
//             <MaterialIcons
//               name="palette"
//               size={18}
//               color={noteColor || colors.muted}
//             />
//           </Pressable>
//           <MaterialIcons name="chevron-right" size={24} color={colors.muted} />
//         </View>
//       </AnimatedCard>
//     );
//   };

//   // Render list cards with day or color sections
//   const renderListCards = () => {
//     if (filteredNotes.length === 0) return null;

//     const sortedNotes = [...filteredNotes].sort(
//       (a, b) =>
//         new Date(b.updated_at || b.created_at).getTime() -
//         new Date(a.updated_at || a.created_at).getTime(),
//     );

//     let globalIndex = 0;

//     // Color grouping mode
//     if (sortMode === 'color') {
//       const colorGroups = groupNotesByColor(sortedNotes);

//       return (
//         <View style={styles.listContainer}>
//           {colorGroups.map(group => (
//             <View key={group.colorId}>
//               <View style={styles.colorSectionHeader}>
//                 <View
//                   style={[
//                     styles.colorSectionDot,
//                     {
//                       backgroundColor:
//                         group.colorValue || theme.colors.muted + '40',
//                       borderWidth: group.colorValue ? 0 : 1,
//                       borderColor: theme.colors.muted,
//                     },
//                   ]}
//                 />
//                 <Text style={styles.colorSectionTitle}>{group.label}</Text>
//                 <Text style={styles.colorSectionCount}>
//                   ({group.notes.length})
//                 </Text>
//               </View>
//               <View style={styles.listSectionCards}>
//                 {group.notes.map(note => {
//                   const cardIndex = globalIndex++;
//                   return renderListCard(note, cardIndex);
//                 })}
//               </View>
//             </View>
//           ))}
//         </View>
//       );
//     }

//     // Recent mode (default) - group by day
//     const groupedNotes = groupNotesByDay(sortedNotes);

//     return (
//       <View style={styles.listContainer}>
//         {groupedNotes.map(group => (
//           <View key={group.title}>
//             <Text style={styles.listSectionTitle}>{group.title}</Text>
//             <View style={styles.listSectionCards}>
//               {group.notes.map(note => {
//                 const cardIndex = globalIndex++;
//                 return renderListCard(note, cardIndex);
//               })}
//             </View>
//           </View>
//         ))}
//       </View>
//     );
//   };

//   return (
//     <SafeAreaView style={styles.screen} edges={['top']}>
//       <View style={styles.container}>
//         <Animated.View
//           style={[
//             styles.header,
//             {
//               opacity: headerFadeAnim,
//               transform: [{translateY: headerSlideAnim}],
//             },
//           ]}>
//           <AppleTouchFeedback
//             hapticStyle="impactLight"
//             onPress={() => navigate('Home')}>
//             <MaterialIcons
//               name="arrow-back-ios"
//               size={24}
//               color={colors.foreground}
//             />
//           </AppleTouchFeedback>
//           <Text style={styles.title}>My Notes</Text>
//           <View style={styles.headerActions}>
//             {notes.length > 0 && (
//               <Pressable
//                 style={styles.exportBtn}
//                 onPress={() => exportAllNotes(notes)}>
//                 <MaterialIcons
//                   name="ios-share"
//                   size={20}
//                   color={colors.foreground}
//                 />
//               </Pressable>
//             )}
//             <Pressable
//               style={[
//                 styles.sortToggle,
//                 sortMode === 'color' && styles.sortToggleActive,
//               ]}
//               onPress={toggleSortMode}>
//               <MaterialIcons
//                 name="palette"
//                 size={20}
//                 color={
//                   sortMode === 'color'
//                     ? theme.colors.buttonText1
//                     : colors.foreground
//                 }
//               />
//             </Pressable>
//             <Pressable style={styles.viewToggle} onPress={toggleViewMode}>
//               <MaterialIcons
//                 name={viewMode === 'grid' ? 'view-list' : 'grid-view'}
//                 size={22}
//                 color={colors.foreground}
//               />
//             </Pressable>
//           </View>
//         </Animated.View>

//         <Animated.View
//           style={[
//             styles.searchContainer,
//             {
//               opacity: searchFadeAnim,
//               transform: [{scale: searchScaleAnim}],
//             },
//           ]}>
//           <Animated.View
//             style={[
//               styles.searchInputWrapper,
//               {borderColor: searchBorderColor},
//             ]}>
//             <MaterialIcons
//               name="search"
//               size={22}
//               color={isSearchFocused ? theme.colors.primary : colors.muted}
//               style={styles.searchIcon}
//             />
//             <TextInput
//               placeholder="Search notes..."
//               placeholderTextColor={colors.muted}
//               style={styles.searchInput}
//               value={searchQuery}
//               onChangeText={setSearchQuery}
//               onFocus={() => setIsSearchFocused(true)}
//               onBlur={() => setIsSearchFocused(false)}
//             />
//             {searchQuery.length > 0 && (
//               <TouchableOpacity
//                 style={styles.searchClearBtn}
//                 onPress={() => {
//                   h('impactLight');
//                   setSearchQuery('');
//                 }}>
//                 <MaterialIcons name="close" size={20} color={colors.muted} />
//               </TouchableOpacity>
//             )}
//           </Animated.View>
//         </Animated.View>

//         {isLoading ? (
//           <View style={styles.loadingContainer}>
//             <View style={styles.loadingDots}>
//               {[0, 1, 2].map(i => (
//                 <Animated.View
//                   key={i}
//                   style={[styles.loadingDot, {opacity: headerFadeAnim}]}
//                 />
//               ))}
//             </View>
//           </View>
//         ) : filteredNotes.length === 0 ? (
//           <Animated.View
//             style={[
//               styles.emptyContainer,
//               {
//                 opacity: emptyStateAnim,
//                 transform: [
//                   {
//                     scale: emptyStateAnim.interpolate({
//                       inputRange: [0, 1],
//                       outputRange: [0.9, 1],
//                     }),
//                   },
//                 ],
//               },
//             ]}>
//             <View style={styles.emptyIconContainer}>
//               <MaterialIcons
//                 name="note-add"
//                 size={56}
//                 color={theme.colors.primary}
//               />
//             </View>
//             <Text style={styles.emptyTitle}>
//               {searchQuery ? 'No Results' : 'No Notes Yet'}
//             </Text>
//             <Text style={styles.emptyText}>
//               {searchQuery
//                 ? 'Try a different search term'
//                 : 'Tap the "+" button to create your first note\nor save text from the Web Browser'}
//             </Text>
//           </Animated.View>
//         ) : (
//           <ScrollView
//             showsVerticalScrollIndicator={false}
//             refreshControl={
//               <RefreshControl
//                 refreshing={refreshing}
//                 onRefresh={onRefresh}
//                 tintColor={theme.colors.primary}
//               />
//             }>
//             {/* Stats Row */}
//             <Animated.View style={[styles.statsRow, {opacity: searchFadeAnim}]}>
//               <View style={styles.statCard}>
//                 <Text style={styles.statNumber}>{filteredNotes.length}</Text>
//                 <Text style={styles.statLabel}>Total Notes</Text>
//               </View>
//               <View style={styles.statCard}>
//                 <Text style={styles.statNumber}>
//                   {filteredNotes.filter(n => n.url).length}
//                 </Text>
//                 <Text style={styles.statLabel}>Saved Links</Text>
//               </View>
//             </Animated.View>

//             {/* Section Header */}
//             <View style={styles.sectionHeader}>
//               <Text style={styles.sectionTitle}>
//                 {searchQuery ? 'Search Results' : 'Recent Notes'}
//               </Text>
//             </View>

//             {/* Cards - Grid or List */}
//             {viewMode === 'grid' ? renderGridCards() : renderListCards()}
//           </ScrollView>
//         )}
//       </View>

//       <Animated.View
//         style={[styles.addButton, {transform: [{scale: fabScaleAnim}]}]}>
//         <Pressable
//           onPress={() => {
//             h('impactMedium');
//             navigate('SaveNote');
//           }}
//           onPressIn={handleFabPressIn}
//           onPressOut={handleFabPressOut}>
//           <MaterialIcons name="add" size={32} color="#FFFFFF" />
//         </Pressable>
//       </Animated.View>

//       {/* Color Picker Modal */}
//       <ColorPickerModal
//         visible={colorModalVisible}
//         onClose={() => {
//           setColorModalVisible(false);
//           setSelectedNoteForColor(null);
//         }}
//         onSelectColor={handleColorSelect}
//         currentColor={selectedNoteForColor?.color}
//         theme={theme}
//       />
//     </SafeAreaView>
//   );
// }