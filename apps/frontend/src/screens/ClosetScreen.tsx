import React, {useState, useEffect, useMemo, useRef, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Dimensions,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Animated,
  Easing,
  Alert,
  Pressable,
  TextInput,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {FlashList} from '@shopify/flash-list';
import {FlatList} from 'react-native';
import FastImage from 'react-native-fast-image';
import {useAppTheme} from '../context/ThemeContext';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {getInferredCategory} from '../utils/categoryUtils';
import {MainCategory, Subcategory} from '../types/categoryTypes';
import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {useUUID} from '../context/UUIDContext';
import {apiClient} from '../lib/apiClient';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {TooltipBubble} from '../components/ToolTip/ToolTip1';
import LiquidGlassCard from '../components/LiquidGlassCard/LiquidGlassCard';
import {useClosetVoiceCommands} from '../utils/VoiceUtils/VoiceContext';
import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';
import {getClosetLocations, addClosetLocation, updateClosetLocation, removeClosetLocation} from '../lib/trips/tripsStorage';
import type {ClosetLocation} from '../types/trips';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {saveEventToIOSCalendar, deleteEventFromIOSCalendar, checkIOSCalendarEventExists} from '../utils/calendarSync';
import DateTimePicker from '@react-native-community/datetimepicker';

const DRY_CLEANER_EVENT_KEY = '@styliq_dry_cleaner_event_id';
const DRY_CLEANER_PROMPTED_KEY = '@styliq_dry_cleaner_prompted';
const DRY_CLEANER_NAME_KEY = '@styliq_dry_cleaner_name';

const {width: SCREEN_WIDTH} = Dimensions.get('window');
const NUM_COLUMNS = 2;
const ITEM_SPACING = 12;
const ITEM_WIDTH = (SCREEN_WIDTH - ITEM_SPACING * 3) / NUM_COLUMNS;
const ITEM_HEIGHT = ITEM_WIDTH * 1.3;

// Horizontal sections view card sizing
const HORIZ_CARD_WIDTH = 140;
const HORIZ_CARD_HEIGHT = 120;

// Animated pressable with scale effect for images
const ScalePressable = ({
  children,
  onPress,
  onLongPress,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  style?: any;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.96,
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
      <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

type WardrobeItem = {
  id: string;
  image_url: string;
  thumbnailUrl?: string;
  processedImageUrl?: string;
  touchedUpImageUrl?: string;
  name: string;
  color?: string;
  main_category?: MainCategory | string;
  subcategory?: Subcategory | string;
  fit?: string;
  size?: string;
  brand?: string;
  material?: string;
  width?: number;
  height?: number;
  favorite?: boolean;
  location_id?: string;
  care_status?: string;
  cleaner_info?: string;
};

type Props = {
  navigate: (screen: string, params?: any) => void;
};

const CATEGORY_META: Array<{
  value: MainCategory | 'All';
  label: string;
  icon: string;
}> = [
  {value: 'All', label: 'All', icon: 'category'},
  {value: 'Tops', label: 'Tops', icon: 'checkroom'},
  {value: 'Bottoms', label: 'Bottoms', icon: 'drag-handle'},
  {value: 'Shoes', label: 'Shoes', icon: 'hiking'},
  {value: 'Outerwear', label: 'Outerwear', icon: 'ac-unit'},
  {value: 'Dresses', label: 'Dresses', icon: 'dry-cleaning'},
  {value: 'Skirts', label: 'Skirts', icon: 'drag-handle'},
  {value: 'Activewear', label: 'Activewear', icon: 'fitness-center'},
  {value: 'Loungewear', label: 'Loungewear', icon: 'weekend'},
  {value: 'Formalwear', label: 'Formalwear', icon: 'work'},
  {value: 'Sleepwear', label: 'Sleepwear', icon: 'hotel'},
  {value: 'Swimwear', label: 'Swimwear', icon: 'pool'},
  {value: 'Accessories', label: 'Accessories', icon: 'watch'},
  {value: 'Bags', label: 'Bags', icon: 'shopping-bag'},
  {value: 'Jewelry', label: 'Jewelry', icon: 'diamond'},
  {value: 'Headwear', label: 'Headwear', icon: 'face'},
  {value: 'Undergarments', label: 'Undergarments', icon: 'layers'},
  {value: 'TraditionalWear', label: 'Traditional Wear', icon: 'festival'},
  {value: 'Unisex', label: 'Unisex', icon: 'wc'},
  {value: 'Maternity', label: 'Maternity', icon: 'pregnant-woman'},
  {value: 'Costumes', label: 'Costumes', icon: 'theater-comedy'},
  {value: 'Other', label: 'Other', icon: 'more-horiz'},
];

const sortOptions = [
  {label: 'Name A-Z', value: 'az'},
  {label: 'Name Z-A', value: 'za'},
  {label: 'Favorites First', value: 'favorites'},
];

type FlatListItem = {
  type: 'header' | 'subheader' | 'item';
  id: string;
  mainCategory?: string;
  subCategory?: string;
  item?: WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory};
};

const LOCATION_COLOR_KEY: Record<string, string> = {
  home: 'success',
  office: 'button4',
  parents: 'warning',
  partner: '_pink',
};

const LOCATION_FIXED_COLORS: Record<string, string> = {
  _pink: '#FF69B4',
};

/** Color options for the add-location picker. */
const LOCATION_COLOR_OPTIONS: {key: string; label: string}[] = [
  {key: 'success', label: 'Green'},
  {key: 'button4', label: 'Blue'},
  {key: 'warning', label: 'Yellow'},
  {key: '_pink', label: 'Pink'},
  {key: 'error', label: 'Red'},
  {key: 'secondary', label: 'Teal'},
  {key: 'muted', label: 'Gray'},
];

/** Resolve a color key to an actual color value. */
function resolveColorKey(
  key: string,
  colors: Record<string, string>,
): string {
  return LOCATION_FIXED_COLORS[key] ?? colors[key] ?? colors.muted;
}

function getLocationDotColor(
  locationId: string | undefined,
  colors: Record<string, string>,
  locationColor?: string,
): string {
  // Prefer stored color from ClosetLocation.color
  if (locationColor) return resolveColorKey(locationColor, colors);
  const id = locationId ?? 'home';
  const key = LOCATION_COLOR_KEY[id] ?? 'muted';
  return resolveColorKey(key, colors);
}

export default function ClosetScreen({navigate}: Props) {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const queryClient = useQueryClient();
  const userId = useUUID();

  const insets = useSafeAreaInsets();
  const [swipeActive, setSwipeActive] = useState(false);
  const scrollEnabled = !swipeActive;

  // Sync scroll position with global nav for bottom nav hide/show
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (global.__navScrollY) {
        global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
      }
    },
    [],
  );

  const [selectedCategory, setSelectedCategory] = useState<
    'All' | MainCategory
  >('All');
  const [sortOption, setSortOption] = useState<'az' | 'za' | 'favorites'>('az');
  const [viewMode, setViewMode] = useState<'grid' | 'sections'>('grid');

  // Load persisted view mode
  useEffect(() => {
    AsyncStorage.getItem('closet_view_mode').then(val => {
      if (val === 'grid' || val === 'sections') {
        setViewMode(val);
      }
    });
  }, []);

  // Persist view mode on change
  useEffect(() => {
    AsyncStorage.setItem('closet_view_mode', viewMode);
  }, [viewMode]);

  // Load closet locations for edit modal
  useEffect(() => {
    getClosetLocations().then(setClosetLocations);
  }, []);

  // Menu states
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'filter' | 'sort'>('main');

  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedItemToEdit, setSelectedItemToEdit] =
    useState<WardrobeItem | null>(null);
  const [editedLocationId, setEditedLocationId] = useState('home');
  const [editedCareStatus, setEditedCareStatus] = useState<'available' | 'at_cleaner'>('available');
  const [editedCleanerInfo, setEditedCleanerInfo] = useState('');
  const [closetLocations, setClosetLocations] = useState<ClosetLocation[]>([]);

  // Dry cleaner pickup reminder state
  const [showPickupDatePicker, setShowPickupDatePicker] = useState(false);
  const [pickupDate, setPickupDate] = useState(new Date());
  const [hasPickupEvent, setHasPickupEvent] = useState(false);
  const prevCareStatusRef = useRef<Record<string, string | undefined>>({});

  // Edit-location modal state
  const [editingLocation, setEditingLocation] = useState<ClosetLocation | null>(null);
  const [editLocName, setEditLocName] = useState('');
  const [editLocColor, setEditLocColor] = useState('');

  const handleAddClosetLocation = useCallback(() => {
    Alert.prompt('New Location', 'Enter a name for this location:', async (text) => {
      const trimmed = (text ?? '').trim();
      if (!trimmed) return;
      const loc = await addClosetLocation(trimmed);
      if (!loc) {
        Alert.alert('Duplicate', 'A location with that name already exists.');
        return;
      }
      setClosetLocations(prev => [...prev, loc]);
      setEditedLocationId(loc.id);
    });
  }, []);

  const openEditLocation = useCallback((loc: ClosetLocation) => {
    if (loc.id === 'home') return; // Home is not editable
    // Close item-edit modal first so they never overlap
    setShowEditModal(false);
    setTimeout(() => {
      setEditLocName(loc.label);
      setEditLocColor(loc.color ?? '');
      setEditingLocation(loc);
    }, 0);
  }, []);

  const screenFade = useRef(new Animated.Value(0)).current;
  const screenTranslate = useRef(new Animated.Value(50)).current;
  const fabBounce = useRef(new Animated.Value(250)).current;

  const submenuOpacity = useRef(new Animated.Value(0)).current;

  // Demo wardrobe state - tracks if user has ever had real wardrobe items
  const [hasEverHadWardrobe, setHasEverHadWardrobe] = useState<boolean | null>(
    null,
  );

  // Demo wardrobe items (bundled assets)
  const demoWardrobeItems: WardrobeItem[] = [
    {
      id: 'demo-top-1',
      image_url: Image.resolveAssetSource(
        require('../assets/images/top-sweater1.png'),
      ).uri,
      name: 'Cable Knit Sweater',
      main_category: 'Tops',
      subcategory: 'Sweaters',
      color: 'Orange',
    },
    {
      id: 'demo-bottom-1',
      image_url: Image.resolveAssetSource(
        require('../assets/images/bottoms-jeans1.png'),
      ).uri,
      name: 'Classic Blue Jeans',
      main_category: 'Bottoms',
      subcategory: 'Jeans',
      color: 'Blue',
    },
    {
      id: 'demo-shoe-1',
      image_url: Image.resolveAssetSource(
        require('../assets/images/shoes-loafers1.jpg'),
      ).uri,
      name: 'Black Leather Loafers',
      main_category: 'Shoes',
      subcategory: 'Loafers',
      color: 'Black',
    },
  ];

  useEffect(() => {
    Animated.sequence([
      Animated.timing(screenFade, {
        toValue: 1,
        duration: 800,
        easing: Easing.out(Easing.exp),
        useNativeDriver: true,
      }),
      Animated.spring(screenTranslate, {
        toValue: 0,
        speed: 2,
        bounciness: 14,
        useNativeDriver: true,
      }),
    ]).start();
    Animated.spring(fabBounce, {
      toValue: 0,
      delay: 900,
      speed: 2,
      bounciness: 14,
      useNativeDriver: true,
    }).start();
  }, []);

  // Load hasEverHadWardrobe flag from AsyncStorage
  useEffect(() => {
    const loadDemoFlag = async () => {
      try {
        const hasWardrobe = await AsyncStorage.getItem('wardrobe_has_real');
        setHasEverHadWardrobe(hasWardrobe === 'true');
      } catch (err) {
        console.error('Failed to load wardrobe demo flag:', err);
        setHasEverHadWardrobe(false);
      }
    };
    loadDemoFlag();
  }, []);

  const {data: wardrobe = [], isLoading} = useQuery({
    queryKey: ['wardrobe', userId],
    queryFn: async () => {
      const res = await apiClient.get('/wardrobe');
      return res.data;
    },
    enabled: !!userId,
    staleTime: 30000,
  });

  // Update hasEverHadWardrobe when real content appears
  useEffect(() => {
    if (wardrobe && wardrobe.length > 0 && hasEverHadWardrobe === false) {
      setHasEverHadWardrobe(true);
      AsyncStorage.setItem('wardrobe_has_real', 'true');
    }
  }, [wardrobe, hasEverHadWardrobe]);

  // Compute wardrobe state: 'demo' | 'real' | 'empty-real'
  const wardrobeState =
    wardrobe && wardrobe.length > 0
      ? 'real'
      : hasEverHadWardrobe
        ? 'empty-real'
        : 'demo';

  // Use demo items when in demo state, otherwise use real wardrobe
  const displayWardrobe =
    wardrobeState === 'demo' ? demoWardrobeItems : wardrobe;

  const hSelect = () =>
    ReactNativeHapticFeedback.trigger('selection', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/wardrobe/${id}`);
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
      const prev = queryClient.getQueryData<WardrobeItem[]>([
        'wardrobe',
        userId,
      ]);
      queryClient.setQueryData<WardrobeItem[]>(
        ['wardrobe', userId],
        old => old?.filter(item => item.id !== id) || [],
      );
      return {prev};
    },
    onError: (_err, _id, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['wardrobe', userId], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      color,
      location_id,
      care_status,
      cleaner_info,
    }: {
      id: string;
      name?: string;
      color?: string;
      location_id?: string;
      care_status?: string;
      cleaner_info?: string | null;
    }) => {
      const body: Record<string, any> = {};
      if (name !== undefined) body.name = name;
      if (color !== undefined) body.color = color;
      if (location_id !== undefined) body.location_id = location_id;
      if (care_status !== undefined) body.care_status = care_status;
      if (cleaner_info !== undefined) body.cleaner_info = cleaner_info;
      await apiClient.put(`/wardrobe/${id}`, body);
    },
    onMutate: async ({id, name, color, location_id, care_status, cleaner_info}) => {
      await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
      const prev = queryClient.getQueryData<WardrobeItem[]>([
        'wardrobe',
        userId,
      ]);
      queryClient.setQueryData<WardrobeItem[]>(
        ['wardrobe', userId],
        old =>
          old?.map(item =>
            item.id === id
              ? {
                  ...item,
                  name: name ?? item.name,
                  color: color ?? item.color,
                  location_id: location_id ?? item.location_id,
                  care_status: care_status ?? item.care_status,
                  cleaner_info: cleaner_info !== undefined ? (cleaner_info ?? undefined) : item.cleaner_info,
                }
              : item,
          ) || [],
      );
      return {prev};
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['wardrobe', userId], context.prev);
      }
    },
    onSuccess: async (_data, variables) => {
      const prevCareStatus = prevCareStatusRef.current[variables.id];
      delete prevCareStatusRef.current[variables.id];
      const newCareStatus = variables.care_status;

      if (prevCareStatus !== 'at_cleaner' && newCareStatus === 'at_cleaner') {
        if (variables.cleaner_info?.trim()) {
          await AsyncStorage.setItem(DRY_CLEANER_NAME_KEY, variables.cleaner_info.trim());
        }
        await promptPickupReminder();
      }

      if (prevCareStatus === 'at_cleaner' && newCareStatus !== 'at_cleaner') {
        const updatedWardrobe = (wardrobe ?? []).map((i: WardrobeItem) =>
          i.id === variables.id ? {...i, care_status: newCareStatus} : i,
        );
        await cleanupPickupReminder(updatedWardrobe);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
    },
  });

  const returnToItemModal = useCallback(() => {
    setEditingLocation(null);
    if (selectedItemToEdit) {
      setTimeout(() => setShowEditModal(true), 0);
    }
  }, [selectedItemToEdit]);

  const handleSaveEditLocation = useCallback(async () => {
    if (!editingLocation) return;
    const updates: {label?: string; color?: string} = {};
    const trimmedName = editLocName.trim();
    if (trimmedName && trimmedName !== editingLocation.label) {
      updates.label = trimmedName;
    }
    if (editLocColor !== (editingLocation.color ?? '')) {
      updates.color = editLocColor;
    }
    if (Object.keys(updates).length === 0) {
      returnToItemModal();
      return;
    }
    const ok = await updateClosetLocation(editingLocation.id, updates);
    if (!ok) {
      Alert.alert('Error', 'Could not update. Name may already be in use.');
      return;
    }
    const fresh = await getClosetLocations();
    setClosetLocations(fresh);
    returnToItemModal();
  }, [editingLocation, editLocName, editLocColor, returnToItemModal]);

  const handleDeleteLocation = useCallback(async () => {
    if (!editingLocation || editingLocation.id === 'home') return;
    Alert.alert(
      'Remove Location',
      `Remove "${editingLocation.label}"? Items and trips using it will be moved to Home.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const itemsToReassign = (wardrobe ?? []).filter(
              (item: WardrobeItem) => item.location_id === editingLocation.id,
            );
            for (const item of itemsToReassign) {
              updateMutation.mutate({id: item.id, location_id: 'home'});
            }
            await removeClosetLocation(editingLocation.id);
            const fresh = await getClosetLocations();
            setClosetLocations(fresh);
            if (editedLocationId === editingLocation.id) {
              setEditedLocationId('home');
            }
            returnToItemModal();
          },
        },
      ],
    );
  }, [editingLocation, wardrobe, updateMutation, editedLocationId, returnToItemModal]);

  // Hydrate hasPickupEvent on mount and when edit modal opens
  useEffect(() => {
    AsyncStorage.getItem(DRY_CLEANER_EVENT_KEY).then(val => setHasPickupEvent(!!val));
  }, [showEditModal]);

  const promptPickupReminder = useCallback(async () => {
    const alreadyPrompted = await AsyncStorage.getItem(DRY_CLEANER_PROMPTED_KEY);
    if (alreadyPrompted === '1') return;
    const existingId = await AsyncStorage.getItem(DRY_CLEANER_EVENT_KEY);
    if (existingId) return;
    await AsyncStorage.setItem(DRY_CLEANER_PROMPTED_KEY, '1');
    Alert.alert(
      'Schedule Dry Cleaning Pickup?',
      'Would you like a reminder to pick up your clothes?',
      [
        {text: 'Later', style: 'cancel'},
        {
          text: 'Schedule',
          onPress: () => {
            setPickupDate(new Date());
            setShowPickupDatePicker(true);
          },
        },
      ],
    );
  }, []);

  const createPickupEvent = useCallback(async (date: Date) => {
    const existingId = await AsyncStorage.getItem(DRY_CLEANER_EVENT_KEY);
    if (existingId) {
      const exists = await checkIOSCalendarEventExists(existingId);
      if (exists) {
        setHasPickupEvent(true);
        return;
      }
      await AsyncStorage.removeItem(DRY_CLEANER_EVENT_KEY);
    }
    const cleanerName = (await AsyncStorage.getItem(DRY_CLEANER_NAME_KEY))?.trim();
    const eventId = await saveEventToIOSCalendar({
      title: '🧺 Dry Cleaning Pickup',
      startDate: date,
      endDate: new Date(date.getTime() + 30 * 60000),
      notes: cleanerName || 'Dry cleaner pickup',
    });
    if (eventId) {
      await AsyncStorage.setItem(DRY_CLEANER_EVENT_KEY, eventId);
      setHasPickupEvent(true);
    }
  }, []);

  const cleanupPickupReminder = useCallback(async (updatedWardrobe: WardrobeItem[]) => {
    const anyAtCleaner = updatedWardrobe.some(i => i.care_status === 'at_cleaner');
    if (anyAtCleaner) return;
    const eventId = await AsyncStorage.getItem(DRY_CLEANER_EVENT_KEY);
    if (eventId) {
      await deleteEventFromIOSCalendar(eventId);
    }
    await AsyncStorage.multiRemove([DRY_CLEANER_EVENT_KEY, DRY_CLEANER_PROMPTED_KEY, DRY_CLEANER_NAME_KEY]);
    setHasPickupEvent(false);
  }, []);

  const filtered = useMemo(() => {
    return (displayWardrobe as WardrobeItem[])
      .map(item => {
        const inferred = getInferredCategory(item.name);
        const effectiveMain: MainCategory | undefined =
          (item.main_category as MainCategory) ?? inferred?.main;
        return {...item, inferredCategory: inferred, effectiveMain};
      })
      .filter(item => {
        if (selectedCategory === 'All') return true;
        return item.effectiveMain === selectedCategory;
      })
      .sort((a, b) => {
        if (sortOption === 'az') return a.name.localeCompare(b.name);
        if (sortOption === 'za') return b.name.localeCompare(a.name);
        if (sortOption === 'favorites')
          return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
        return 0;
      });
  }, [displayWardrobe, selectedCategory, sortOption]);

  // Lookup: location_id → stored color key from closetLocations
  const locColorMap = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    closetLocations.forEach(loc => { map[loc.id] = loc.color; });
    return map;
  }, [closetLocations]);

  // Flatten categorized items for FlashList
  const flatListData = useMemo(() => {
    const result: FlatListItem[] = [];
    const categorized: Record<
      string,
      Record<
        string,
        (WardrobeItem & {
          inferredCategory?: any;
          effectiveMain?: MainCategory;
        })[]
      >
    > = {};

    for (const item of filtered) {
      const main =
        (item.main_category as string) ||
        item.inferredCategory?.main ||
        'Uncategorized';
      const sub =
        (item.subcategory as string) || item.inferredCategory?.sub || 'General';
      if (!categorized[main]) categorized[main] = {};
      if (!categorized[main][sub]) categorized[main][sub] = [];
      categorized[main][sub].push(item);
    }

    for (const [mainCategory, subMap] of Object.entries(categorized)) {
      result.push({
        type: 'header',
        id: `header-${mainCategory}`,
        mainCategory,
      });

      for (const [subCategory, items] of Object.entries(subMap)) {
        result.push({
          type: 'subheader',
          id: `subheader-${mainCategory}-${subCategory}`,
          mainCategory,
          subCategory,
        });

        for (const item of items) {
          result.push({
            type: 'item',
            id: `item-${item.id}`,
            mainCategory,
            subCategory,
            item,
          });
        }
      }
    }

    return result;
  }, [filtered]);

  // Group filtered items by main category for sections view
  const categorizedSections = useMemo(() => {
    const grouped: Record<
      string,
      (WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory})[]
    > = {};

    for (const item of filtered) {
      const main =
        (item.main_category as string) ||
        item.inferredCategory?.main ||
        'Uncategorized';
      if (!grouped[main]) grouped[main] = [];
      grouped[main].push(item);
    }

    return Object.entries(grouped).map(([category, items]) => ({
      category,
      items,
    }));
  }, [filtered]);

  // FAB state
  const [fabOpen, setFabOpen] = useState(false);
  const fabAnim = useRef(new Animated.Value(0)).current;

  const toggleFab = () => {
    ReactNativeHapticFeedback.trigger('impactLight', {
      enableVibrateFallback: true,
    });
    Animated.spring(fabAnim, {
      toValue: fabOpen ? 0 : 1,
      useNativeDriver: false,
      friction: 6,
      tension: 40,
    }).start();
    setFabOpen(!fabOpen);
  };

  const fabOpacity = fabAnim.interpolate({
    inputRange: [0, 0.6, 1],
    outputRange: [0, 0.9, 1],
  });

  const favoriteMutation = useMutation({
    mutationFn: async ({id, favorite}: {id: string; favorite: boolean}) => {
      await apiClient.put(`/wardrobe/favorite/${id}`, {favorite});
    },
    onMutate: async ({id, favorite}) => {
      await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
      const prev = queryClient.getQueryData<WardrobeItem[]>([
        'wardrobe',
        userId,
      ]);
      queryClient.setQueryData<WardrobeItem[]>(
        ['wardrobe', userId],
        old =>
          old?.map(item => (item.id === id ? {...item, favorite} : item)) || [],
      );
      return {prev};
    },
    onError: (err, _, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['wardrobe', userId], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
    },
  });

  const styles = StyleSheet.create({
    buttonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      marginTop: 10,
    },
    popover: {
      position: 'absolute',
      top: insets.top + 115,
      right: 20,
      width: 220,
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 14,
      elevation: 20,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowOffset: {width: 0, height: 4},
      shadowRadius: 14,
      zIndex: 9999,
    },
    submenu: {
      position: 'absolute',
      top: insets.top + 115,
      right: 16,
      width: 320,
      maxHeight: Dimensions.get('window').height * 0.7,
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 18,
      elevation: 20,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowOffset: {width: 0, height: 4},
      shadowRadius: 14,
      zIndex: 9999,
    },
    optionRow: {
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
    },
    optionText: {
      fontSize: 16,
      color: theme.colors.foreground,
      marginLeft: 8,
    },
    mainOptionText: {
      fontSize: 17,
      color: theme.colors.foreground,
      fontWeight: tokens.fontWeight.semiBold,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.background,
    },
    itemContainer: {
      // width: ITEM_WIDTH,
      marginBottom: 6,
      // backgroundColor: 'red'
    },
    itemImage: {
      width: '100%',
      height: ITEM_HEIGHT,
      backgroundColor: theme.colors.imageBackground,
    },
    itemRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      paddingHorizontal: ITEM_SPACING,
    },
    imageArea: {
      width: '100%',
      flex: 1,             
      justifyContent: 'center',
      alignItems: 'center',   
      paddingTop: 20,
    },
    imageSlot: {
      width: '60%',           
      height: 180,           
      borderRadius: tokens.borderRadius.switch1,
      overflow: 'hidden',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 8
    },
    image: {
      width: '100%',
      height: '100%',
    },
    horizImageArea: {
      width: '100%',
      flex: 1,                 
      justifyContent: 'center',  
      alignItems: 'center',     
      paddingVertical: 12,
    },
    horizImageSlot: {
      width: '60%',             
      height: HORIZ_CARD_HEIGHT, 
      overflow: 'hidden',
      justifyContent: 'center',
      alignItems: 'center',
    },
    horizImage: {
      width: '100%',
      height: '100%',
    },
  });

  const openSubmenu = (view: 'filter' | 'sort') => {
    setMenuView(view);
    submenuOpacity.setValue(0);
    Animated.timing(submenuOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  useClosetVoiceCommands(
    openSubmenu,
    setMenuVisible,
    setSelectedCategory,
    setSortOption,
  );

  const renderItem = useCallback(
    ({item: listItem}: {item: FlatListItem}) => {
      if (listItem.type === 'header') {
        return (
          <View style={{paddingHorizontal: 4, marginTop: 16}}>
            <Animated.Text
              style={[
                globalStyles.sectionTitle5,
                {
                  transform: [
                    {
                      translateY: screenFade.interpolate({
                        inputRange: [0, 1],
                        outputRange: [20, 0],
                      }),
                    },
                  ],
                  opacity: screenFade,
                },
              ]}>
              {listItem.mainCategory}
            </Animated.Text>
          </View>
        );
      }

      if (listItem.type === 'subheader') {
        return (
          <View style={{paddingHorizontal: 8}}>
            <Text style={[globalStyles.title3, {color: theme.colors.foreground}]}>{listItem.subCategory}</Text>
          </View>
        );
      }

      const item = listItem.item!;
      const isDemo = item.id.startsWith('demo-');
      const imageUri =
        item.touchedUpImageUrl ??
        item.processedImageUrl ??
        item.thumbnailUrl ??
        item.image_url;

      return (
        <View style={[styles.itemContainer, {marginLeft: 4}]}>
          <ScalePressable
            // style={[globalStyles.outfitCard4]}
            onPress={() => {
              if (isDemo) {
                // For demo items, navigate to AddItem to encourage adding real items
                navigate('AddItem');
              } else {
                navigate('ItemDetail', {itemId: item.id, item});
              }
            }}
            onLongPress={() => {
              if (!isDemo) {
                setEditedLocationId(item.location_id ?? 'home');
                setEditedCareStatus((item.care_status as any) ?? 'available');
                setEditedCleanerInfo(item.cleaner_info ?? '');
                setSelectedItemToEdit(item);
                setShowEditModal(true);
              }
            }}>
            <View style={[styles.imageArea, {backgroundColor: theme.colors.imageBackground}]}>
              <View style={styles.imageSlot}>
                <FastImage
                  source={{
                    uri: imageUri,
                    priority: FastImage.priority.normal,
                    cache: FastImage.cacheControl.immutable,
                  }}
                  style={styles.image}
                  resizeMode={FastImage.resizeMode.contain}
                />
              </View>
            </View>

            {/* Favorite - hide for demo items */}
            {!isDemo && (
              <View
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 10,
                  padding: 2,
                }}>
                <AppleTouchFeedback
                  hapticStyle="impactLight"
                  onPress={() =>
                    favoriteMutation.mutate({
                      id: item.id,
                      favorite: !item.favorite,
                    })
                  }>
                  <MaterialIcons
                    name="favorite"
                    size={26}
                    color={item.favorite ? 'red' : theme.colors.inputBorder}
                  />
                </AppleTouchFeedback>
                <View style={{marginTop: 8}}>
                  <MaterialIcons
                    name="place"
                    size={26}
                    color={getLocationDotColor(item.location_id, theme.colors, locColorMap[item.location_id ?? 'home'])}
                  />
                </View>
                {item.care_status === 'at_cleaner' && (
                  <View style={{marginTop: 8, alignSelf: 'center'}}>
                    <MaterialIcons name="dry-cleaning" size={26} color={theme.colors.warning ?? '#F59E0B'} />
                  </View>
                )}
              </View>
            )}
            {/* Demo badge */}
            {isDemo && (
              <View
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  backgroundColor: 'black',
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                }}>
                <Text
                  style={{
                    color: 'white',
                    fontSize: 11,
                    fontWeight: tokens.fontWeight.semiBold,
                  }}>
                  Sample
                </Text>
              </View>
            )}

            {/* Labels */}
            <View style={[globalStyles.labelContainer, {width: '100%', height: 'auto'}]}>
              <Text
                style={[globalStyles.cardLabel]}
                numberOfLines={1}
                ellipsizeMode="tail">
                {item.name}
              </Text>
              <Text style={[globalStyles.cardSubLabel]} numberOfLines={1}>
                {listItem.subCategory}
              </Text>
            </View>

            {/* Try On - hide for demo items */}
            {/* {!isDemo && (
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={() =>
                  navigate('TryOnOverlay', {
                    outfit: {
                      top: {
                        name: item.name,
                        imageUri: item.image_url,
                      },
                    },
                    userPhotoUri: Image.resolveAssetSource(
                      require('../assets/images/full-body-temp1.png'),
                    ).uri,
                  })
                }
                style={{
                  position: 'absolute',
                  bottom: 150,
                  left: 8,
                  backgroundColor: 'black',
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                }}>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    fontWeight: tokens.fontWeight.medium,
                  }}>
                  Try On
                </Text>
              </AppleTouchFeedback>
            )} */}
          </ScalePressable>
        </View>
      );
    },
    [
      globalStyles,
      screenFade,
      theme,
      navigate,
      favoriteMutation,
      styles.itemContainer,
      wardrobeState,
    ],
  );

  const getItemType = useCallback((item: FlatListItem) => {
    return item.type;
  }, []);

  const keyExtractor = useCallback((item: FlatListItem) => item.id, []);

  // Estimate item sizes for FlashList optimization
  const overrideItemLayout = useCallback(
    (layout: {span?: number; size?: number}, item: FlatListItem): void => {
      if (item.type === 'header') {
        layout.size = 60;
        layout.span = NUM_COLUMNS;
      } else if (item.type === 'subheader') {
        layout.size = 40;
        layout.span = NUM_COLUMNS;
      } else {
        layout.size = ITEM_HEIGHT + 80;
        layout.span = 1;
      }
    },
    [],
  );

  const renderHorizontalCard = useCallback(
    ({
      item,
    }: {
      item: WardrobeItem & {
        inferredCategory?: any;
        effectiveMain?: MainCategory;
      };
    }) => {
      const isDemo = item.id.startsWith('demo-');
      const imageUri =
        item.touchedUpImageUrl ??
        item.processedImageUrl ??
        item.thumbnailUrl ??
        item.image_url;

      return (
        <View style={{width: HORIZ_CARD_WIDTH, marginRight: 8}}>
          <ScalePressable
            style={[globalStyles.outfitCard5, {width: HORIZ_CARD_WIDTH}]}
            onPress={() => {
              if (isDemo) {
                navigate('AddItem');
              } else {
                navigate('ItemDetail', {itemId: item.id, item});
              }
            }}
            onLongPress={() => {
              if (!isDemo) {
                setEditedLocationId(item.location_id ?? 'home');
                setEditedCareStatus((item.care_status as any) ?? 'available');
                setEditedCleanerInfo(item.cleaner_info ?? '');
                setSelectedItemToEdit(item);
                setShowEditModal(true);
              }
            }}>
         <View style={[styles.horizImageArea, {backgroundColor: theme.colors.imageBackground}]}>
            <View style={styles.horizImageSlot}>
              <FastImage
                source={{
                  uri: imageUri,
                  priority: FastImage.priority.normal,
                  cache: FastImage.cacheControl.immutable,
                }}
                style={[styles.horizImage]}
                resizeMode={FastImage.resizeMode.contain}
              />
            </View>
          </View>

            {/* Favorite - hide for demo items */}
            {!isDemo && (
              <View
                style={{
                  position: 'absolute',
                  top: 8,
                  right: -2,
                  zIndex: 10,
                  padding: 4,
                }}>
                <AppleTouchFeedback
                  hapticStyle="impactLight"
                  onPress={() =>
                    favoriteMutation.mutate({
                      id: item.id,
                      favorite: !item.favorite,
                    })
                  }>
                  <MaterialIcons
                    name="favorite"
                    size={22}
                    color={item.favorite ? 'red' : theme.colors.inputBorder}
                  />
                </AppleTouchFeedback>
                 <View style={{marginTop: 6}}>
                  <MaterialIcons
                    name="place"
                    size={22}
                    color={getLocationDotColor(item.location_id, theme.colors, locColorMap[item.location_id ?? 'home'])}
                  />
                </View>
                {item.care_status === 'at_cleaner' && (
                  <View style={{marginTop: 4, alignSelf: 'center'}}>
                    <MaterialIcons name="dry-cleaning" size={22} color={theme.colors.warning ?? '#F59E0B'} />
                  </View>
                )}
              </View>
            )}

            {/* Demo badge */}
            {isDemo && (
              <View
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  backgroundColor: 'black',
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                }}>
                <Text
                  style={{
                    color: 'white',
                    fontSize: 11,
                    fontWeight: tokens.fontWeight.semiBold,
                  }}>
                  Sample
                </Text>
              </View>
            )}

            {/* Labels */}
            <View style={[globalStyles.labelContainer, {width: '100%'}]}>
              <Text
                style={[globalStyles.cardLabel]}
                numberOfLines={1}
                ellipsizeMode="tail">
                {item.name}
              </Text>
              <Text style={[globalStyles.cardSubLabel]} numberOfLines={1}>
                {item.subcategory as string || item.inferredCategory?.sub || ''}
              </Text>
            </View>

            {/* Try On - hide for demo items */}
            {/* {!isDemo && (
              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={() =>
                  navigate('TryOnOverlay', {
                    outfit: {
                      top: {
                        name: item.name,
                        imageUri: item.image_url,
                      },
                    },
                    userPhotoUri: Image.resolveAssetSource(
                      require('../assets/images/full-body-temp1.png'),
                    ).uri,
                  })
                }
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 8,
                  backgroundColor: 'black',
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                }}>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    fontWeight: tokens.fontWeight.medium,
                  }}>
                  Try On
                </Text>
              </AppleTouchFeedback>
            )} */}
          </ScalePressable>
        </View>
      );
    },
    [globalStyles, theme, navigate, favoriteMutation, wardrobeState],
  );

  const horizKeyExtractor = useCallback(
    (
      item: WardrobeItem & {
        inferredCategory?: any;
        effectiveMain?: MainCategory;
      },
    ) => item.id,
    [],
  );

  return (
    <SafeAreaView
      edges={['top']}
      style={[
        globalStyles.screen,
        globalStyles.container,
        {
          flex: 1,
          backgroundColor: theme.colors.background,
          paddingBottom: 0,
        },
      ]}>
      <Animated.View
        style={{
          flex: 1,
          opacity: screenFade,
          transform: [{translateY: screenTranslate}],
        }}>
        <View
          style={{
            height: Math.max(insets.top, 44),
            backgroundColor: theme.colors.background,
          }}
        />

        {/* Header row: title + buttons on one line */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            // paddingHorizontal: 16,
            marginBottom: 8,
          }}>
          <Text style={[globalStyles.header, {marginBottom: 0}]}>Wardrobe</Text>

          <View style={{flexDirection: 'row', alignItems: 'center'}}>
        

            {/* View Mode Toggle */}
            <AppleTouchFeedback
              hapticStyle="impactLight"
              style={{
                paddingHorizontal: 7,
                paddingVertical: 8,
                borderRadius: tokens.borderRadius.sm,
                backgroundColor: theme.colors.button1,
                elevation: 2,
                marginRight: 10,
              }}
              onPress={() => {
                hSelect();
                setViewMode(prev =>
                  prev === 'grid' ? 'sections' : 'grid',
                );
              }}>
              <MaterialIcons
                name={viewMode === 'grid' ? 'view-stream' : 'grid-view'}
                size={28}
                color={theme.colors.buttonText1}
              />
            </AppleTouchFeedback>

            {/* Unified Menu Trigger */}
            <AppleTouchFeedback
              hapticStyle="impactLight"
              style={{
                paddingHorizontal: 7,
                paddingVertical: 8,
                borderRadius: tokens.borderRadius.sm,
                backgroundColor: theme.colors.button1,
                elevation: 2,
              }}
              onPress={() => {
                setMenuVisible(prev => !prev);
                setMenuView('main');
              }}>
              <MaterialIcons
                name="filter-list"
                size={28}
                color={theme.colors.buttonText1}
              />
            </AppleTouchFeedback>
          </View>
        </View>

        {/* Photo tips info bar - shown only while sample items are present */}
        {wardrobeState === 'demo' && (
          <View
            style={{
              backgroundColor: theme.colors.primary + '20',
              paddingVertical: 12,
              paddingHorizontal: 16,
              marginHorizontal: 16,
              marginBottom: 12,
              borderRadius: 10,
            }}>
            <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 8}}>
              <MaterialIcons
                name="info-outline"
                size={18}
                color={theme.colors.primary}
                style={{marginRight: 6}}
              />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  fontWeight: tokens.fontWeight.semiBold,
                }}>
                  This is the place to add your own individual wardrobe items
             
              </Text>
            </View>
            <View style={{paddingLeft: 4}}>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                How to photograph your clothes for best results:
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Lay items flat on a plain background (preferably a plain white flat sheet)
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Smooth wrinkles on all items and avoid shadows
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Take pictures of each item separately using good lighting and close up
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Show/Expose tags on clothes when possible for best descriptions
              </Text>
                <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Start adding your wardrobe items by tapping the '+' button
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
                {'\u2022'} Add items one-by-one or in bulk — wardrobe data is filled in automatically for you
              </Text>
            </View>
          </View>
        )}

        {/* Empty state - only show when user had items before but now has none */}
        {!isLoading && wardrobeState === 'empty-real' && (
          <View style={{flexDirection: 'row', alignSelf: 'center'}}>
            <Text style={globalStyles.missingDataMessage1}>
              No wardrobe items found.
            </Text>
            <View style={{alignSelf: 'flex-start'}}>
              <TooltipBubble
                message="You haven't uploaded any wardrobe items yet. Tap the + button at the bottom to start adding your personal wardrobe inventory."
                position="top"
              />
            </View>
          </View>
        )}

        {/* Wardrobe Views */}
        {viewMode === 'grid' ? (
          <FlashList
            data={flatListData}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            overrideItemLayout={overrideItemLayout}
            numColumns={NUM_COLUMNS}
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            drawDistance={ITEM_HEIGHT * 2}
            contentContainerStyle={{
              paddingHorizontal: ITEM_SPACING / 2,
              paddingBottom: 120,
            }}
          />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            contentContainerStyle={{paddingBottom: 120}}>
            {categorizedSections.map(section => (
              <View key={section.category} style={{marginBottom: 8}}>
                <Animated.Text
                  style={[
                    globalStyles.sectionTitle5,
                    {
                      paddingHorizontal: ITEM_SPACING,
                      marginTop: 4,
                      marginBottom: 4,
                      transform: [
                        {
                          translateY: screenFade.interpolate({
                            inputRange: [0, 1],
                            outputRange: [20, 0],
                          }),
                        },
                      ],
                      opacity: screenFade,
                    },
                  ]}>
                  {section.category}
                </Animated.Text>
                <FlatList
                  data={section.items}
                  renderItem={renderHorizontalCard}
                  keyExtractor={horizKeyExtractor}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{paddingHorizontal: ITEM_SPACING}}
                />
              </View>
            ))}
          </ScrollView>
        )}

        <>
          {/* Floating Mini FABs */}
          {[
            {icon: 'center-focus-weak', onPress: () => navigate('BarcodeScannerScreen'), offset: 3},
            {icon: 'search', onPress: () => navigate('Search'), offset: 2},
            {icon: 'add', onPress: () => navigate('AddItem'), offset: 1},
          ].map((btn, index) => (
            <Animated.View
              key={index}
              style={{
                position: 'absolute',
                bottom: 97,
                right: -2,
                opacity: fabOpacity,

                transform: [
                  {
                    translateX: fabAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -70 * (btn.offset + 0.3)],
                    }),
                  },
                  {scale: fabAnim},
                ],
              }}>
              <View
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 26,
                  borderWidth: 1,
                  borderColor: theme.colors.buttonText1,
                  backgroundColor:
                    btn.icon === 'add'
                      ? 'rgba(54, 54, 54, 0.44)'
                      : 'rgba(54, 54, 54, 0.44)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Pressable
                  onPress={() => {
                    toggleFab();
                    btn.onPress();
                  }}
                  style={{
                    width: '100%',
                    height: '100%',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  {btn.icon === 'add' && (
                    <Text
                      style={{
                        color: theme.colors.buttonText1,
                        fontSize: 9,
                        fontWeight: tokens.fontWeight.semiBold,
                        marginBottom: -2,
                      }}>
                      Add
                    </Text>
                  )}
                  {btn.icon === 'center-focus-weak' && (
                    <Text
                      style={{
                        color: theme.colors.buttonText1,
                        fontSize: 9,
                        fontWeight: tokens.fontWeight.semiBold,
                        marginBottom: -2,
                      }}>
                      Scan
                    </Text>
                  )}
                  <MaterialIcons
                    name={btn.icon}
                    size={btn.icon === 'add' || btn.icon === 'center-focus-weak' ? 20 : 26}
                    color={theme.colors.buttonText1}
                  />
                </Pressable>
              </View>
            </Animated.View>
          ))}

          {/* Main FAB (always visible) */}
          <Animated.View
            style={{
              position: 'absolute',
              bottom: 96,
              right: 18,
              transform: [{translateY: fabBounce}],
            }}>
            <View
              style={{
                width: 54,
                height: 54,
                borderRadius: 32,
                borderWidth: 1,
                borderColor: theme.colors.foreground,
                backgroundColor: 'rgba(54, 54, 54, 0.44)',
                alignItems: 'center',
                justifyContent: 'center',
                
              }}>
              <Pressable
                onPress={toggleFab}
                style={{
                  width: '100%',
                  height: '100%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  
                }}>
                <Animated.View
                  style={{
                    transform: [
                      {
                        rotate: fabAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: ['0deg', '45deg'],
                        }),
                      },
                    ],
                  }}>
                  <MaterialIcons
                    name="add"
                    size={32}
                    color={theme.colors.buttonText1}
                  />
                </Animated.View>
              </Pressable>
            </View>
          </Animated.View>
        </>

        {/* Popover + Submenus */}
        {menuVisible && (
          <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
            <View
              style={{
                position: 'absolute',
                top: -60,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'transparent',
                zIndex: 9999,
              }}>
              <TouchableWithoutFeedback>
                <View>
                  {menuView === 'main' && (
                    <View style={styles.popover}>
                      <TouchableOpacity
                        style={styles.optionRow}
                        onPress={() => {
                          hSelect();
                          openSubmenu('filter');
                        }}>
                        <MaterialIcons
                          name="filter-list"
                          size={24}
                          color={theme.colors.foreground}
                        />
                        <Text style={styles.mainOptionText}>Filter</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.optionRow}
                        onPress={() => {
                          hSelect();
                          openSubmenu('sort');
                        }}>
                        <MaterialIcons
                          name="sort"
                          size={22}
                          color={theme.colors.foreground}
                        />
                        <Text style={styles.mainOptionText}>Sort</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {menuView === 'filter' && (
                    <Animated.View
                      style={[
                        styles.submenu,
                        {
                          opacity: submenuOpacity,
                          transform: [
                            {
                              scale: submenuOpacity.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0.95, 1],
                              }),
                            },
                          ],
                        },
                      ]}>
                      <ScrollView
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={{paddingBottom: 8}}>
                        {CATEGORY_META.map(cat => (
                          <TouchableOpacity
                            key={cat.value}
                            onPress={() => {
                              hSelect();
                              setSelectedCategory(cat.value as any);
                              setMenuVisible(false);
                            }}
                            style={styles.optionRow}>
                            <MaterialIcons
                              name={cat.icon}
                              size={20}
                              color={theme.colors.foreground}
                            />
                            <Text style={styles.optionText}>{cat.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </Animated.View>
                  )}

                  {menuView === 'sort' && (
                    <Animated.View
                      style={[
                        styles.submenu,
                        {
                          opacity: submenuOpacity,
                          transform: [
                            {
                              scale: submenuOpacity.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0.95, 1],
                              }),
                            },
                          ],
                        },
                      ]}>
                      <ScrollView
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={{paddingBottom: 8}}>
                        {sortOptions.map(opt => (
                          <TouchableOpacity
                            key={opt.value}
                            onPress={() => {
                              hSelect();
                              setSortOption(opt.value as any);
                              setMenuVisible(false);
                            }}
                            style={styles.optionRow}>
                            <MaterialIcons
                              name="sort"
                              size={20}
                              color={theme.colors.foreground}
                            />
                            <Text style={styles.optionText}>{opt.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </Animated.View>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        )}

        {/* Edit Modal */}
        {selectedItemToEdit && showEditModal && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.5)',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 10000,
              elevation: 30,
            }}>
            <TouchableWithoutFeedback onPress={() => setShowEditModal(false)}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                }}
              />
            </TouchableWithoutFeedback>

            <Animated.View
              style={{
                padding: 24,
                borderRadius: 12,
                backgroundColor: theme.colors.surface,
                width: '90%',
                maxWidth: 720,
                opacity: screenFade,
                transform: [
                  {
                    scale: screenFade.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.8, 1],
                    }),
                  },
                ],
              }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: tokens.fontWeight.semiBold,
                  color: theme.colors.foreground,
                  marginBottom: 4,
                }}
                numberOfLines={1}>
                {selectedItemToEdit.name}
              </Text>
              <Text style={{color: theme.colors.foreground, fontSize: 13, marginBottom: 10, opacity: 0.5}}>
                Set Location/Closet
              </Text>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom: 4}}>
                {closetLocations.map(loc => {
                  const selected = editedLocationId === loc.id;
                  const locColor = getLocationDotColor(loc.id, theme.colors, loc.color);
                  return (
                    <TouchableOpacity
                      key={loc.id}
                      onPress={() => setEditedLocationId(loc.id)}
                      onLongPress={() => openEditLocation(loc)}
                      delayLongPress={400}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 20,
                        marginRight: 8,
                        backgroundColor: selected ? locColor : theme.colors.surface3,
                        borderWidth: 1,
                        borderColor: selected ? locColor : theme.colors.inputBorder,
                      }}>
                      <View style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        backgroundColor: selected ? theme.colors.background : locColor,
                        marginRight: 6,
                      }} />
                      <Text style={{
                        fontSize: 13,
                        color: selected ? theme.colors.background : theme.colors.foreground,
                        fontWeight: selected ? '600' : '400',
                      }}>
                        {loc.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  onPress={handleAddClosetLocation}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 20,
                    borderWidth: 1,
                    borderColor: theme.colors.inputBorder,
                    borderStyle: 'dashed',
                  }}>
                  <Text style={{fontSize: 13, color: theme.colors.foreground, opacity: 0.6}}>
                    + Add
                  </Text>
                </TouchableOpacity>
              </ScrollView>

              <Text style={{color: theme.colors.foreground, fontSize: 13, marginTop: 12, marginBottom: 6, opacity: 0.5}}>
                Availability
              </Text>
              <View style={{flexDirection: 'row', marginBottom: 4}}>
                {([
                  {value: 'available' as const, label: 'Available'},
                  {value: 'at_cleaner' as const, label: 'At Cleaner'},
                ]).map(opt => {
                  const sel = editedCareStatus === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => setEditedCareStatus(opt.value)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 20,
                        marginRight: 8,
                        backgroundColor: sel ? theme.colors.primary : theme.colors.surface3,
                        borderWidth: 1,
                        borderColor: sel ? theme.colors.primary : theme.colors.inputBorder,
                      }}>
                      <Text style={{
                        fontSize: 13,
                        color: sel ? theme.colors.background : theme.colors.foreground,
                        fontWeight: sel ? '600' : '400',
                      }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {editedCareStatus === 'at_cleaner' && (
                <>
                  <Text style={{color: theme.colors.foreground, fontSize: 13, marginTop: 12, marginBottom: 6, opacity: 0.5}}>
                    Cleaner Details
                  </Text>
                  <TextInput
                    placeholder="Cleaner name, address..."
                    placeholderTextColor={theme.colors.foreground + '55'}
                    value={editedCleanerInfo}
                    onChangeText={setEditedCleanerInfo}
                    multiline
                    style={{
                      maxHeight: 80,
                      color: theme.colors.foreground,
                      backgroundColor: theme.colors.surface3,
                      borderRadius: 8,
                      padding: 10,
                      fontSize: 14,
                      borderWidth: 1,
                      borderColor: theme.colors.inputBorder,
                    }}
                  />
                  {!hasPickupEvent && (
                    <TouchableOpacity
                      onPress={() => {
                        setPickupDate(new Date());
                        setShowPickupDatePicker(true);
                      }}
                      style={{marginTop: 8}}>
                      <Text style={{color: theme.colors.primary, fontSize: 13}}>
                        Schedule pickup reminder
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              <AppleTouchFeedback
                hapticStyle="impactLight"
                onPress={() => {
                  if (selectedItemToEdit) {
                    prevCareStatusRef.current[selectedItemToEdit.id] = selectedItemToEdit.care_status;
                    updateMutation.mutate({
                      id: selectedItemToEdit.id,
                      location_id: editedLocationId,
                      care_status: editedCareStatus,
                      cleaner_info: editedCareStatus === 'at_cleaner' ? (editedCleanerInfo || null) : null,
                    });
                    setShowEditModal(false);
                    setSelectedItemToEdit(null);
                  }
                }}
                style={{
                  paddingVertical: 12,
                  borderRadius: tokens.borderRadius.sm,
                  alignItems: 'center',
                  backgroundColor: theme.colors.primary,
                  marginTop: 12,
                }}>
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: tokens.fontWeight.semiBold,
                    color: theme.colors.background,
                  }}>
                  Save
                </Text>
              </AppleTouchFeedback>
            </Animated.View>
          </View>
        )}

        {/* Edit Location Modal */}
        {editingLocation && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
            }}>
            <TouchableWithoutFeedback onPress={returnToItemModal}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(0,0,0,0.5)',
                }}
              />
            </TouchableWithoutFeedback>
            <View
              style={{
                padding: 24,
                borderRadius: 12,
                backgroundColor: theme.colors.surface,
                width: '90%',
                maxWidth: 720,
              }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: tokens.fontWeight.semiBold,
                  color: theme.colors.foreground,
                  marginBottom: 12,
                }}>
                Edit Location
              </Text>

              {/* Rename */}
              <Text style={{fontSize: 12, color: theme.colors.foreground, opacity: 0.5, marginBottom: 4}}>
                Name
              </Text>
              <TextInput
                style={{
                  backgroundColor: theme.colors.surface3,
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 15,
                  color: theme.colors.foreground,
                  borderWidth: 1,
                  borderColor: theme.colors.inputBorder,
                  marginBottom: 14,
                }}
                value={editLocName}
                onChangeText={setEditLocName}
                placeholder="Location name"
                placeholderTextColor={theme.colors.foreground + '60'}
              />

              {/* Color Picker */}
              <Text style={{fontSize: 12, color: theme.colors.foreground, opacity: 0.5, marginBottom: 6}}>
                Color
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom: 16}}>
                {LOCATION_COLOR_OPTIONS.map(opt => {
                  const isActive = editLocColor === opt.key;
                  const dotColor = resolveColorKey(opt.key, theme.colors);
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      onPress={() => setEditLocColor(opt.key)}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: dotColor,
                        marginRight: 10,
                        borderWidth: isActive ? 3 : 1,
                        borderColor: isActive ? theme.colors.foreground : theme.colors.inputBorder,
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}>
                      {isActive && (
                        <MaterialIcons name="check" size={16} color={theme.colors.background} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Delete */}
              <TouchableOpacity
                onPress={handleDeleteLocation}
                style={{marginBottom: 14}}>
                <Text style={{fontSize: 14, color: theme.colors.error ?? '#FF3B30', fontWeight: '600'}}>
                  Delete Location
                </Text>
              </TouchableOpacity>

              {/* Actions */}
              <View style={{flexDirection: 'row', gap: 10}}>
                <TouchableOpacity
                  onPress={returnToItemModal}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: tokens.borderRadius.sm,
                    alignItems: 'center',
                    backgroundColor: theme.colors.surface3,
                  }}>
                  <Text style={{fontSize: 15, color: theme.colors.foreground, fontWeight: '600'}}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleSaveEditLocation}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: tokens.borderRadius.sm,
                    alignItems: 'center',
                    backgroundColor: theme.colors.primary,
                  }}>
                  <Text style={{fontSize: 15, color: theme.colors.background, fontWeight: '600'}}>
                    Save
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* Dry Cleaner Pickup DateTimePicker */}
        {showPickupDatePicker && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
            }}>
            <TouchableWithoutFeedback onPress={() => setShowPickupDatePicker(false)}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(0,0,0,0.4)',
                }}
              />
            </TouchableWithoutFeedback>
            <View style={{backgroundColor: theme.colors.surface, borderRadius: 16, padding: 20, width: '85%'}}>
              <Text style={{color: theme.colors.foreground, fontSize: 16, fontWeight: '600', marginBottom: 12}}>
                Pickup Date & Time
              </Text>
              <DateTimePicker
                value={pickupDate}
                mode="datetime"
                display="compact"
                minimumDate={new Date()}
                onChange={(_e, date) => { if (date) setPickupDate(date); }}
                accentColor={theme.colors.primary}
              />
              <View style={{flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16, gap: 16}}>
                <TouchableOpacity onPress={() => setShowPickupDatePicker(false)}>
                  <Text style={{color: theme.colors.foreground, opacity: 0.6, fontSize: 15}}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={async () => {
                  setShowPickupDatePicker(false);
                  await createPickupEvent(pickupDate);
                }}>
                  <Text style={{color: theme.colors.primary, fontWeight: '600', fontSize: 15}}>Confirm</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </Animated.View>
    </SafeAreaView>
  );
}

//////////////////////

// import React, {useState, useEffect, useMemo, useRef, useCallback} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   Dimensions,
//   TouchableOpacity,
//   TouchableWithoutFeedback,
//   TextInput,
//   Animated,
//   Easing,
//   Alert,
//   Pressable,
//   NativeSyntheticEvent,
//   NativeScrollEvent,
//   ScrollView,
// } from 'react-native';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {FlashList} from '@shopify/flash-list';
// import {FlatList} from 'react-native';
// import FastImage from 'react-native-fast-image';
// import {useAppTheme} from '../context/ThemeContext';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import {getInferredCategory} from '../utils/categoryUtils';
// import {MainCategory, Subcategory} from '../types/categoryTypes';
// import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
// import {useUUID} from '../context/UUIDContext';
// import {apiClient} from '../lib/apiClient';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import LiquidGlassCard from '../components/LiquidGlassCard/LiquidGlassCard';
// import {useClosetVoiceCommands} from '../utils/VoiceUtils/VoiceContext';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useSafeAreaInsets} from 'react-native-safe-area-context';

// const {width: SCREEN_WIDTH} = Dimensions.get('window');
// const NUM_COLUMNS = 2;
// const ITEM_SPACING = 12;
// const ITEM_WIDTH = (SCREEN_WIDTH - ITEM_SPACING * 3) / NUM_COLUMNS;
// const ITEM_HEIGHT = ITEM_WIDTH * 1.3;

// // Horizontal sections view card sizing
// const HORIZ_CARD_WIDTH = 140;
// const HORIZ_CARD_HEIGHT = 100;

// // Animated pressable with scale effect for images
// const ScalePressable = ({
//   children,
//   onPress,
//   onLongPress,
//   style,
// }: {
//   children: React.ReactNode;
//   onPress: () => void;
//   onLongPress?: () => void;
//   style?: any;
// }) => {
//   const scaleAnim = useRef(new Animated.Value(1)).current;

//   const handlePressIn = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 0.96,
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
//       <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
//         {children}
//       </Animated.View>
//     </Pressable>
//   );
// };

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   thumbnailUrl?: string;
//   processedImageUrl?: string;
//   touchedUpImageUrl?: string;
//   name: string;
//   color?: string;
//   main_category?: MainCategory | string;
//   subcategory?: Subcategory | string;
//   fit?: string;
//   size?: string;
//   brand?: string;
//   material?: string;
//   width?: number;
//   height?: number;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string, params?: any) => void;
// };

// const CATEGORY_META: Array<{
//   value: MainCategory | 'All';
//   label: string;
//   icon: string;
// }> = [
//   {value: 'All', label: 'All', icon: 'category'},
//   {value: 'Tops', label: 'Tops', icon: 'checkroom'},
//   {value: 'Bottoms', label: 'Bottoms', icon: 'drag-handle'},
//   {value: 'Shoes', label: 'Shoes', icon: 'hiking'},
//   {value: 'Outerwear', label: 'Outerwear', icon: 'ac-unit'},
//   {value: 'Dresses', label: 'Dresses', icon: 'dry-cleaning'},
//   {value: 'Skirts', label: 'Skirts', icon: 'drag-handle'},
//   {value: 'Activewear', label: 'Activewear', icon: 'fitness-center'},
//   {value: 'Loungewear', label: 'Loungewear', icon: 'weekend'},
//   {value: 'Formalwear', label: 'Formalwear', icon: 'work'},
//   {value: 'Sleepwear', label: 'Sleepwear', icon: 'hotel'},
//   {value: 'Swimwear', label: 'Swimwear', icon: 'pool'},
//   {value: 'Accessories', label: 'Accessories', icon: 'watch'},
//   {value: 'Bags', label: 'Bags', icon: 'shopping-bag'},
//   {value: 'Jewelry', label: 'Jewelry', icon: 'diamond'},
//   {value: 'Headwear', label: 'Headwear', icon: 'face'},
//   {value: 'Undergarments', label: 'Undergarments', icon: 'layers'},
//   {value: 'TraditionalWear', label: 'Traditional Wear', icon: 'festival'},
//   {value: 'Unisex', label: 'Unisex', icon: 'wc'},
//   {value: 'Maternity', label: 'Maternity', icon: 'pregnant-woman'},
//   {value: 'Costumes', label: 'Costumes', icon: 'theater-comedy'},
//   {value: 'Other', label: 'Other', icon: 'more-horiz'},
// ];

// const sortOptions = [
//   {label: 'Name A-Z', value: 'az'},
//   {label: 'Name Z-A', value: 'za'},
//   {label: 'Favorites First', value: 'favorites'},
// ];

// type FlatListItem = {
//   type: 'header' | 'subheader' | 'item';
//   id: string;
//   mainCategory?: string;
//   subCategory?: string;
//   item?: WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory};
// };

// export default function ClosetScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();
//   const userId = useUUID();

//   const insets = useSafeAreaInsets();
//   const [swipeActive, setSwipeActive] = useState(false);
//   const scrollEnabled = !swipeActive;

//   // Sync scroll position with global nav for bottom nav hide/show
//   const handleScroll = useCallback(
//     (event: NativeSyntheticEvent<NativeScrollEvent>) => {
//       if (global.__navScrollY) {
//         global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
//       }
//     },
//     [],
//   );

//   const [selectedCategory, setSelectedCategory] = useState<
//     'All' | MainCategory
//   >('All');
//   const [sortOption, setSortOption] = useState<'az' | 'za' | 'favorites'>('az');
//   const [viewMode, setViewMode] = useState<'grid' | 'sections'>('grid');

//   // Load persisted view mode
//   useEffect(() => {
//     AsyncStorage.getItem('closet_view_mode').then(val => {
//       if (val === 'grid' || val === 'sections') {
//         setViewMode(val);
//       }
//     });
//   }, []);

//   // Persist view mode on change
//   useEffect(() => {
//     AsyncStorage.setItem('closet_view_mode', viewMode);
//   }, [viewMode]);

//   // Menu states
//   const [menuVisible, setMenuVisible] = useState(false);
//   const [menuView, setMenuView] = useState<'main' | 'filter' | 'sort'>('main');

//   const [showEditModal, setShowEditModal] = useState(false);
//   const [selectedItemToEdit, setSelectedItemToEdit] =
//     useState<WardrobeItem | null>(null);
//   const [editedName, setEditedName] = useState('');
//   const [editedColor, setEditedColor] = useState('');

//   const screenFade = useRef(new Animated.Value(0)).current;
//   const screenTranslate = useRef(new Animated.Value(50)).current;
//   const fabBounce = useRef(new Animated.Value(250)).current;

//   const submenuOpacity = useRef(new Animated.Value(0)).current;

//   // Demo wardrobe state - tracks if user has ever had real wardrobe items
//   const [hasEverHadWardrobe, setHasEverHadWardrobe] = useState<boolean | null>(
//     null,
//   );

//   // Demo wardrobe items (bundled assets)
//   const demoWardrobeItems: WardrobeItem[] = [
//     {
//       id: 'demo-top-1',
//       image_url: Image.resolveAssetSource(
//         require('../assets/images/top-sweater1.png'),
//       ).uri,
//       name: 'Cable Knit Sweater',
//       main_category: 'Tops',
//       subcategory: 'Sweaters',
//       color: 'Orange',
//     },
//     {
//       id: 'demo-bottom-1',
//       image_url: Image.resolveAssetSource(
//         require('../assets/images/bottoms-jeans1.png'),
//       ).uri,
//       name: 'Classic Blue Jeans',
//       main_category: 'Bottoms',
//       subcategory: 'Jeans',
//       color: 'Blue',
//     },
//     {
//       id: 'demo-shoe-1',
//       image_url: Image.resolveAssetSource(
//         require('../assets/images/shoes-loafers1.jpg'),
//       ).uri,
//       name: 'Black Leather Loafers',
//       main_category: 'Shoes',
//       subcategory: 'Loafers',
//       color: 'Black',
//     },
//   ];

//   useEffect(() => {
//     Animated.sequence([
//       Animated.timing(screenFade, {
//         toValue: 1,
//         duration: 800,
//         easing: Easing.out(Easing.exp),
//         useNativeDriver: true,
//       }),
//       Animated.spring(screenTranslate, {
//         toValue: 0,
//         speed: 2,
//         bounciness: 14,
//         useNativeDriver: true,
//       }),
//     ]).start();
//     Animated.spring(fabBounce, {
//       toValue: 0,
//       delay: 900,
//       speed: 2,
//       bounciness: 14,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   // Load hasEverHadWardrobe flag from AsyncStorage
//   useEffect(() => {
//     const loadDemoFlag = async () => {
//       try {
//         const hasWardrobe = await AsyncStorage.getItem('wardrobe_has_real');
//         setHasEverHadWardrobe(hasWardrobe === 'true');
//       } catch (err) {
//         console.error('Failed to load wardrobe demo flag:', err);
//         setHasEverHadWardrobe(false);
//       }
//     };
//     loadDemoFlag();
//   }, []);

//   const {data: wardrobe = [], isLoading} = useQuery({
//     queryKey: ['wardrobe', userId],
//     queryFn: async () => {
//       const res = await apiClient.get('/wardrobe');
//       return res.data;
//     },
//     enabled: !!userId,
//     staleTime: 30000,
//   });

//   // Update hasEverHadWardrobe when real content appears
//   useEffect(() => {
//     if (wardrobe && wardrobe.length > 0 && hasEverHadWardrobe === false) {
//       setHasEverHadWardrobe(true);
//       AsyncStorage.setItem('wardrobe_has_real', 'true');
//     }
//   }, [wardrobe, hasEverHadWardrobe]);

//   // Compute wardrobe state: 'demo' | 'real' | 'empty-real'
//   const wardrobeState =
//     wardrobe && wardrobe.length > 0
//       ? 'real'
//       : hasEverHadWardrobe
//         ? 'empty-real'
//         : 'demo';

//   // Use demo items when in demo state, otherwise use real wardrobe
//   const displayWardrobe =
//     wardrobeState === 'demo' ? demoWardrobeItems : wardrobe;

//   const hSelect = () =>
//     ReactNativeHapticFeedback.trigger('selection', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       await apiClient.delete(`/wardrobe/${id}`);
//     },
//     onMutate: async (id: string) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old => old?.filter(item => item.id !== id) || [],
//       );
//       return {prev};
//     },
//     onError: (_err, _id, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const updateMutation = useMutation({
//     mutationFn: async ({
//       id,
//       name,
//       color,
//     }: {
//       id: string;
//       name?: string;
//       color?: string;
//     }) => {
//       await apiClient.put(`/wardrobe/${id}`, {name, color});
//     },
//     onMutate: async ({id, name, color}) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old =>
//           old?.map(item =>
//             item.id === id
//               ? {...item, name: name ?? item.name, color: color ?? item.color}
//               : item,
//           ) || [],
//       );
//       return {prev};
//     },
//     onError: (_err, _vars, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const filtered = useMemo(() => {
//     return (displayWardrobe as WardrobeItem[])
//       .map(item => {
//         const inferred = getInferredCategory(item.name);
//         const effectiveMain: MainCategory | undefined =
//           (item.main_category as MainCategory) ?? inferred?.main;
//         return {...item, inferredCategory: inferred, effectiveMain};
//       })
//       .filter(item => {
//         if (selectedCategory === 'All') return true;
//         return item.effectiveMain === selectedCategory;
//       })
//       .sort((a, b) => {
//         if (sortOption === 'az') return a.name.localeCompare(b.name);
//         if (sortOption === 'za') return b.name.localeCompare(a.name);
//         if (sortOption === 'favorites')
//           return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
//         return 0;
//       });
//   }, [displayWardrobe, selectedCategory, sortOption]);

//   // Flatten categorized items for FlashList
//   const flatListData = useMemo(() => {
//     const result: FlatListItem[] = [];
//     const categorized: Record<
//       string,
//       Record<
//         string,
//         (WardrobeItem & {
//           inferredCategory?: any;
//           effectiveMain?: MainCategory;
//         })[]
//       >
//     > = {};

//     for (const item of filtered) {
//       const main =
//         (item.main_category as string) ||
//         item.inferredCategory?.main ||
//         'Uncategorized';
//       const sub =
//         (item.subcategory as string) || item.inferredCategory?.sub || 'General';
//       if (!categorized[main]) categorized[main] = {};
//       if (!categorized[main][sub]) categorized[main][sub] = [];
//       categorized[main][sub].push(item);
//     }

//     for (const [mainCategory, subMap] of Object.entries(categorized)) {
//       result.push({
//         type: 'header',
//         id: `header-${mainCategory}`,
//         mainCategory,
//       });

//       for (const [subCategory, items] of Object.entries(subMap)) {
//         result.push({
//           type: 'subheader',
//           id: `subheader-${mainCategory}-${subCategory}`,
//           mainCategory,
//           subCategory,
//         });

//         for (const item of items) {
//           result.push({
//             type: 'item',
//             id: `item-${item.id}`,
//             mainCategory,
//             subCategory,
//             item,
//           });
//         }
//       }
//     }

//     return result;
//   }, [filtered]);

//   // Group filtered items by main category for sections view
//   const categorizedSections = useMemo(() => {
//     const grouped: Record<
//       string,
//       (WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory})[]
//     > = {};

//     for (const item of filtered) {
//       const main =
//         (item.main_category as string) ||
//         item.inferredCategory?.main ||
//         'Uncategorized';
//       if (!grouped[main]) grouped[main] = [];
//       grouped[main].push(item);
//     }

//     return Object.entries(grouped).map(([category, items]) => ({
//       category,
//       items,
//     }));
//   }, [filtered]);

//   // FAB state
//   const [fabOpen, setFabOpen] = useState(false);
//   const fabAnim = useRef(new Animated.Value(0)).current;

//   const toggleFab = () => {
//     ReactNativeHapticFeedback.trigger('impactLight', {
//       enableVibrateFallback: true,
//     });
//     Animated.spring(fabAnim, {
//       toValue: fabOpen ? 0 : 1,
//       useNativeDriver: false,
//       friction: 6,
//       tension: 40,
//     }).start();
//     setFabOpen(!fabOpen);
//   };

//   const fabOpacity = fabAnim.interpolate({
//     inputRange: [0, 0.6, 1],
//     outputRange: [0, 0.9, 1],
//   });

//   const favoriteMutation = useMutation({
//     mutationFn: async ({id, favorite}: {id: string; favorite: boolean}) => {
//       await apiClient.put(`/wardrobe/favorite/${id}`, {favorite});
//     },
//     onMutate: async ({id, favorite}) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old =>
//           old?.map(item => (item.id === id ? {...item, favorite} : item)) || [],
//       );
//       return {prev};
//     },
//     onError: (err, _, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const styles = StyleSheet.create({
//     buttonRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'flex-end',
//       marginTop: 10,
//     },
//     popover: {
//       position: 'absolute',
//       top: insets.top + 115,
//       right: 20,
//       width: 220,
//       backgroundColor: theme.colors.surface,
//       borderRadius: 16,
//       paddingVertical: 12,
//       paddingHorizontal: 14,
//       elevation: 20,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowOffset: {width: 0, height: 4},
//       shadowRadius: 14,
//       zIndex: 9999,
//     },
//     submenu: {
//       position: 'absolute',
//       top: insets.top + 115,
//       right: 16,
//       width: 320,
//       maxHeight: Dimensions.get('window').height * 0.7,
//       backgroundColor: theme.colors.surface,
//       borderRadius: 16,
//       paddingVertical: 16,
//       paddingHorizontal: 18,
//       elevation: 20,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowOffset: {width: 0, height: 4},
//       shadowRadius: 14,
//       zIndex: 9999,
//     },
//     optionRow: {
//       paddingVertical: 10,
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     optionText: {
//       fontSize: 16,
//       color: theme.colors.foreground,
//       marginLeft: 8,
//     },
//     mainOptionText: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: theme.colors.inputBorder,
//       borderRadius: 8,
//       padding: 12,
//       marginBottom: 12,
//       color: theme.colors.foreground,
//       backgroundColor: theme.colors.background,
//     },
//     itemContainer: {
//       width: ITEM_WIDTH,
//       marginBottom: 15,
//     },
//     itemImage: {
//       width: '100%',
//       height: ITEM_HEIGHT,
//       backgroundColor: theme.colors.surface,
//       borderTopLeftRadius: tokens.borderRadius.sm,
//       borderTopRightRadius: tokens.borderRadius.sm,
//     },
//     itemRow: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'space-between',
//       paddingHorizontal: ITEM_SPACING,
//     },
//   });

//   const openSubmenu = (view: 'filter' | 'sort') => {
//     setMenuView(view);
//     submenuOpacity.setValue(0);
//     Animated.timing(submenuOpacity, {
//       toValue: 1,
//       duration: 180,
//       useNativeDriver: true,
//     }).start();
//   };

//   useClosetVoiceCommands(
//     openSubmenu,
//     setMenuVisible,
//     setSelectedCategory,
//     setSortOption,
//   );

//   const renderItem = useCallback(
//     ({item: listItem}: {item: FlatListItem}) => {
//       if (listItem.type === 'header') {
//         return (
//           // <View style={globalStyles.section}>
//           <View style={{paddingHorizontal: 4, marginTop: 16}}>
//             <Animated.Text
//               style={[
//                 globalStyles.sectionTitle5,
//                 {
//                   transform: [
//                     {
//                       translateY: screenFade.interpolate({
//                         inputRange: [0, 1],
//                         outputRange: [20, 0],
//                       }),
//                     },
//                   ],
//                   opacity: screenFade,
//                 },
//               ]}>
//               {listItem.mainCategory}
//             </Animated.Text>
//           </View>
//         );
//       }

//       if (listItem.type === 'subheader') {
//         return (
//           <View style={{paddingHorizontal: ITEM_SPACING}}>
//             <Text style={[globalStyles.title3]}>{listItem.subCategory}</Text>
//           </View>
//         );
//       }

//       const item = listItem.item!;
//       const isDemo = item.id.startsWith('demo-');
//       const imageUri =
//         item.touchedUpImageUrl ??
//         item.processedImageUrl ??
//         item.thumbnailUrl ??
//         item.image_url;

//       return (
//         <View style={styles.itemContainer}>
//           <ScalePressable
//             style={globalStyles.outfitCard4}
//             onPress={() => {
//               if (isDemo) {
//                 // For demo items, navigate to AddItem to encourage adding real items
//                 navigate('AddItem');
//               } else {
//                 navigate('ItemDetail', {itemId: item.id, item});
//               }
//             }}
//             onLongPress={() => {
//               if (!isDemo) {
//                 setEditedName(item.name ?? '');
//                 setEditedColor(item.color ?? '');
//                 setSelectedItemToEdit(item);
//                 setShowEditModal(true);
//               }
//             }}>
//             <View
//               style={{
//                 width: '100%',
//                 backgroundColor: theme.colors.surface,
//               }}>
//               <FastImage
//                 source={{
//                   uri: imageUri,
//                   priority: FastImage.priority.normal,
//                   cache: FastImage.cacheControl.immutable,
//                 }}
//                 style={globalStyles.image11}
//                 resizeMode={FastImage.resizeMode.contain}
//               />
//             </View>

//             {/* Favorite - hide for demo items */}
//             {!isDemo && (
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 8,
//                   right: 8,
//                   zIndex: 10,
//                   padding: 4,
//                 }}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() =>
//                     favoriteMutation.mutate({
//                       id: item.id,
//                       favorite: !item.favorite,
//                     })
//                   }>
//                   <MaterialIcons
//                     name="favorite"
//                     size={28}
//                     color={item.favorite ? 'red' : theme.colors.inputBorder}
//                   />
//                 </AppleTouchFeedback>
//               </View>
//             )}

//             {/* Demo badge */}
//             {isDemo && (
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 8,
//                   right: 8,
//                   backgroundColor: 'black',
//                   paddingHorizontal: 8,
//                   paddingVertical: 3,
//                   borderRadius: 6,
//                 }}>
//                 <Text
//                   style={{
//                     color: 'white',
//                     fontSize: 11,
//                     fontWeight: tokens.fontWeight.semiBold,
//                   }}>
//                   Sample
//                 </Text>
//               </View>
//             )}

//             {/* Labels */}
//             <View style={globalStyles.labelContainer}>
//               <Text
//                 style={[globalStyles.cardLabel]}
//                 numberOfLines={1}
//                 ellipsizeMode="tail">
//                 {item.name}
//               </Text>
//               <Text style={[globalStyles.cardSubLabel]} numberOfLines={1}>
//                 {listItem.subCategory}
//               </Text>
//             </View>

//             {/* Try On - hide for demo items */}
//             {!isDemo && (
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() =>
//                   navigate('TryOnOverlay', {
//                     outfit: {
//                       top: {
//                         name: item.name,
//                         imageUri: item.image_url,
//                       },
//                     },
//                     userPhotoUri: Image.resolveAssetSource(
//                       require('../assets/images/full-body-temp1.png'),
//                     ).uri,
//                   })
//                 }
//                 style={{
//                   position: 'absolute',
//                   top: 10,
//                   left: 8,
//                   backgroundColor: 'black',
//                   paddingHorizontal: 10,
//                   paddingVertical: 4,
//                   borderRadius: 8,
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     fontSize: 14,
//                     fontWeight: tokens.fontWeight.medium,
//                   }}>
//                   Try On
//                 </Text>
//               </AppleTouchFeedback>
//             )}
//           </ScalePressable>
//         </View>
//       );
//     },
//     [
//       globalStyles,
//       screenFade,
//       theme,
//       navigate,
//       favoriteMutation,
//       styles.itemContainer,
//       wardrobeState,
//     ],
//   );

//   const getItemType = useCallback((item: FlatListItem) => {
//     return item.type;
//   }, []);

//   const keyExtractor = useCallback((item: FlatListItem) => item.id, []);

//   // Estimate item sizes for FlashList optimization
//   const overrideItemLayout = useCallback(
//     (layout: {span?: number; size?: number}, item: FlatListItem): void => {
//       if (item.type === 'header') {
//         layout.size = 60;
//         layout.span = NUM_COLUMNS;
//       } else if (item.type === 'subheader') {
//         layout.size = 40;
//         layout.span = NUM_COLUMNS;
//       } else {
//         layout.size = ITEM_HEIGHT + 80;
//         layout.span = 1;
//       }
//     },
//     [],
//   );

//   const renderHorizontalCard = useCallback(
//     ({
//       item,
//     }: {
//       item: WardrobeItem & {
//         inferredCategory?: any;
//         effectiveMain?: MainCategory;
//       };
//     }) => {
//       const isDemo = item.id.startsWith('demo-');
//       const imageUri =
//         item.touchedUpImageUrl ??
//         item.processedImageUrl ??
//         item.thumbnailUrl ??
//         item.image_url;

//       return (
//         <View style={{width: HORIZ_CARD_WIDTH, marginRight: 10}}>
//           <ScalePressable
//             style={[globalStyles.outfitCard5, {width: HORIZ_CARD_WIDTH}]}
//             onPress={() => {
//               if (isDemo) {
//                 navigate('AddItem');
//               } else {
//                 navigate('ItemDetail', {itemId: item.id, item});
//               }
//             }}
//             onLongPress={() => {
//               if (!isDemo) {
//                 setEditedName(item.name ?? '');
//                 setEditedColor(item.color ?? '');
//                 setSelectedItemToEdit(item);
//                 setShowEditModal(true);
//               }
//             }}>
//             <View
//               style={{
//                 width: '100%',
//                 backgroundColor: theme.colors.surface,
//                 // backgroundColor: 'white',
//                 padding: 8
//               }}>
//               <FastImage
//                 source={{
//                   uri: imageUri,
//                   priority: FastImage.priority.normal,
//                   cache: FastImage.cacheControl.immutable,
//                 }}
//                 style={{width: '100%', height: HORIZ_CARD_HEIGHT}}
//                 resizeMode={FastImage.resizeMode.contain}
//               />
//             </View>

//             {/* Favorite - hide for demo items */}
//             {!isDemo && (
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 8,
//                   right: 8,
//                   zIndex: 10,
//                   padding: 4,
//                 }}>
//                 <AppleTouchFeedback
//                   hapticStyle="impactLight"
//                   onPress={() =>
//                     favoriteMutation.mutate({
//                       id: item.id,
//                       favorite: !item.favorite,
//                     })
//                   }>
//                   <MaterialIcons
//                     name="favorite"
//                     size={28}
//                     color={item.favorite ? 'red' : theme.colors.inputBorder}
//                   />
//                 </AppleTouchFeedback>
//               </View>
//             )}

//             {/* Demo badge */}
//             {isDemo && (
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 8,
//                   right: 8,
//                   backgroundColor: 'black',
//                   paddingHorizontal: 8,
//                   paddingVertical: 3,
//                   borderRadius: 6,
//                 }}>
//                 <Text
//                   style={{
//                     color: 'white',
//                     fontSize: 11,
//                     fontWeight: tokens.fontWeight.semiBold,
//                   }}>
//                   Sample
//                 </Text>
//               </View>
//             )}

//             {/* Labels */}
//             <View style={globalStyles.labelContainer}>
//               <Text
//                 style={[globalStyles.cardLabel]}
//                 numberOfLines={1}
//                 ellipsizeMode="tail">
//                 {item.name}
//               </Text>
//               <Text style={[globalStyles.cardSubLabel]} numberOfLines={1}>
//                 {item.subcategory as string || item.inferredCategory?.sub || ''}
//               </Text>
//             </View>

//             {/* Try On - hide for demo items */}
//             {!isDemo && (
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() =>
//                   navigate('TryOnOverlay', {
//                     outfit: {
//                       top: {
//                         name: item.name,
//                         imageUri: item.image_url,
//                       },
//                     },
//                     userPhotoUri: Image.resolveAssetSource(
//                       require('../assets/images/full-body-temp1.png'),
//                     ).uri,
//                   })
//                 }
//                 style={{
//                   position: 'absolute',
//                   top: 10,
//                   left: 8,
//                   backgroundColor: 'black',
//                   paddingHorizontal: 10,
//                   paddingVertical: 4,
//                   borderRadius: 8,
//                 }}>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     fontSize: 14,
//                     fontWeight: tokens.fontWeight.medium,
//                   }}>
//                   Try On
//                 </Text>
//               </AppleTouchFeedback>
//             )}
//           </ScalePressable>
//         </View>
//       );
//     },
//     [globalStyles, theme, navigate, favoriteMutation, wardrobeState],
//   );

//   const horizKeyExtractor = useCallback(
//     (
//       item: WardrobeItem & {
//         inferredCategory?: any;
//         effectiveMain?: MainCategory;
//       },
//     ) => item.id,
//     [],
//   );

//   return (
//     <SafeAreaView
//       edges={['top']}
//       style={[
//         globalStyles.screen,
//         globalStyles.container,
//         {
//           flex: 1,
//           backgroundColor: theme.colors.background,
//           paddingBottom: 0,
//         },
//       ]}>
//       <Animated.View
//         style={{
//           flex: 1,
//           opacity: screenFade,
//           transform: [{translateY: screenTranslate}],
//         }}>
//         <View
//           style={{
//             height: Math.max(insets.top, 44),
//             backgroundColor: 'theme.colors.background',
//           }}
//         />
      

//         {/* Header row: title + buttons on one line */}
//         <View
//           style={{
//             flexDirection: 'row',
//             alignItems: 'center',
//             justifyContent: 'space-between',
//             // paddingHorizontal: 16,
//             marginBottom: 8,
//           }}>
//           <Text style={[globalStyles.header, {marginBottom: 0}]}>Wardrobe</Text>

//           <View style={{flexDirection: 'row', alignItems: 'center'}}>
//             <AppleTouchFeedback
//               style={[
//                 globalStyles.buttonPrimary,
//                 {
//                   paddingHorizontal: 16,
//                   paddingVertical: 11,
//                   marginRight: 10,
//                 },
//               ]}
//               hapticStyle="impactMedium"
//               onPress={() => {
//                 ReactNativeHapticFeedback.trigger('notificationSuccess', {
//                   enableVibrateFallback: true,
//                   ignoreAndroidSystemSettings: false,
//                 });
//                 navigate('OutfitCanvas');
//               }}>
//               <Text style={globalStyles.buttonPrimaryText}>+ Build An Outfit</Text>
//             </AppleTouchFeedback>

//             {/* View Mode Toggle */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               style={{
//                 paddingHorizontal: 7,
//                 paddingVertical: 8,
//                 borderRadius: tokens.borderRadius.sm,
//                 backgroundColor: theme.colors.button1,
//                 elevation: 2,
//                 marginRight: 10,
//               }}
//               onPress={() => {
//                 hSelect();
//                 setViewMode(prev =>
//                   prev === 'grid' ? 'sections' : 'grid',
//                 );
//               }}>
//               <MaterialIcons
//                 name={viewMode === 'grid' ? 'view-stream' : 'grid-view'}
//                 size={28}
//                 color={theme.colors.buttonText1}
//               />
//             </AppleTouchFeedback>

//             {/* Unified Menu Trigger */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               style={{
//                 paddingHorizontal: 7,
//                 paddingVertical: 8,
//                 borderRadius: tokens.borderRadius.sm,
//                 backgroundColor: theme.colors.button1,
//                 elevation: 2,
//               }}
//               onPress={() => {
//                 setMenuVisible(prev => !prev);
//                 setMenuView('main');
//               }}>
//               <MaterialIcons
//                 name="filter-list"
//                 size={28}
//                 color={theme.colors.buttonText1}
//               />
//             </AppleTouchFeedback>
//           </View>
//         </View>

//         {/* Photo tips info bar - shown only while sample items are present */}
//         {wardrobeState === 'demo' && (
//           <View
//             style={{
//               backgroundColor: theme.colors.primary + '20',
//               paddingVertical: 12,
//               paddingHorizontal: 16,
//               marginHorizontal: 16,
//               marginBottom: 12,
//               borderRadius: 10,
//             }}>
//             <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 8}}>
//               <MaterialIcons
//                 name="info-outline"
//                 size={18}
//                 color={theme.colors.primary}
//                 style={{marginRight: 6}}
//               />
//               <Text
//                 style={{
//                   color: theme.colors.foreground,
//                   fontSize: 14,
//                   fontWeight: tokens.fontWeight.semiBold,
//                 }}>
//                   This is the place to add your own individual wardrobe items
             
//               </Text>
//             </View>
//             <View style={{paddingLeft: 4}}>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 How to photograph your clothes for best results:
//               </Text>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Lay items flat on a plain background (preferably a plain white flat sheet)
//               </Text>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Smooth wrinkles on all items and avoid shadows
//               </Text>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Take pictures of each item separately using good lighting and close up
//               </Text>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Show/Expose tags on clothes when possible for best descriptions
//               </Text>
//                 <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Start adding your wardrobe items by tapping the '+' button
//               </Text>
//               <Text style={{color: theme.colors.foreground, fontSize: 13, lineHeight: 20}}>
//                 {'\u2022'} Add items one-by-one or in bulk — wardrobe data is filled in automatically for you
//               </Text>
//             </View>
//           </View>
//         )}

//         {/* Empty state - only show when user had items before but now has none */}
//         {!isLoading && wardrobeState === 'empty-real' && (
//           <View style={{flexDirection: 'row', alignSelf: 'center'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No wardrobe items found.
//             </Text>
//             <View style={{alignSelf: 'flex-start'}}>
//               <TooltipBubble
//                 message="You haven't uploaded any wardrobe items yet. Tap the + button at the bottom to start adding your personal wardrobe inventory."
//                 position="top"
//               />
//             </View>
//           </View>
//         )}

//         {/* Wardrobe Views */}
//         {viewMode === 'grid' ? (
//           <FlashList
//             data={flatListData}
//             renderItem={renderItem}
//             keyExtractor={keyExtractor}
//             getItemType={getItemType}
//             overrideItemLayout={overrideItemLayout}
//             numColumns={NUM_COLUMNS}
//             showsVerticalScrollIndicator={false}
//             onScroll={handleScroll}
//             scrollEventThrottle={16}
//             drawDistance={ITEM_HEIGHT * 2}
//             contentContainerStyle={{
//               paddingHorizontal: ITEM_SPACING / 2,
//               paddingBottom: 120,
//             }}
//           />
//         ) : (
//           <ScrollView
//             showsVerticalScrollIndicator={false}
//             onScroll={handleScroll}
//             scrollEventThrottle={16}
//             contentContainerStyle={{paddingBottom: 120}}>
//             {categorizedSections.map(section => (
//               <View key={section.category} style={{marginBottom: 8}}>
//                 <Animated.Text
//                   style={[
//                     globalStyles.sectionTitle5,
//                     {
//                       paddingHorizontal: ITEM_SPACING,
//                       marginTop: 16,
//                       marginBottom: 8,
//                       transform: [
//                         {
//                           translateY: screenFade.interpolate({
//                             inputRange: [0, 1],
//                             outputRange: [20, 0],
//                           }),
//                         },
//                       ],
//                       opacity: screenFade,
//                     },
//                   ]}>
//                   {section.category}
//                 </Animated.Text>
//                 <FlatList
//                   data={section.items}
//                   renderItem={renderHorizontalCard}
//                   keyExtractor={horizKeyExtractor}
//                   horizontal
//                   showsHorizontalScrollIndicator={false}
//                   contentContainerStyle={{paddingHorizontal: ITEM_SPACING}}
//                 />
//               </View>
//             ))}
//           </ScrollView>
//         )}

//         <>
//           {/* Floating Mini FABs */}
//           {[
//             {icon: 'center-focus-weak', onPress: () => navigate('BarcodeScannerScreen'), offset: 3},
//             {icon: 'search', onPress: () => navigate('Search'), offset: 2},
//             {icon: 'add', onPress: () => navigate('AddItem'), offset: 1},
//           ].map((btn, index) => (
//             <Animated.View
//               key={index}
//               style={{
//                 position: 'absolute',
//                 bottom: 97,
//                 right: -2,
//                 opacity: fabOpacity,

//                 transform: [
//                   {
//                     translateX: fabAnim.interpolate({
//                       inputRange: [0, 1],
//                       outputRange: [0, -70 * (btn.offset + 0.3)],
//                     }),
//                   },
//                   {scale: fabAnim},
//                 ],
//               }}>
//               <View
//                 style={{
//                   width: 50,
//                   height: 50,
//                   borderRadius: 26,
//                   borderWidth: 1,
//                   borderColor: theme.colors.buttonText1,
//                   backgroundColor:
//                     btn.icon === 'add'
//                       ? theme.colors.button1
//                       : 'rgba(54, 54, 54, 0.44)',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <Pressable
//                   onPress={() => {
//                     toggleFab();
//                     btn.onPress();
//                   }}
//                   style={{
//                     width: '100%',
//                     height: '100%',
//                     alignItems: 'center',
//                     justifyContent: 'center',
//                   }}>
//                   {btn.icon === 'add' && (
//                     <Text
//                       style={{
//                         color: theme.colors.foreground,
//                         fontSize: 9,
//                         fontWeight: tokens.fontWeight.semiBold,
//                         marginBottom: -2,
//                       }}>
//                       Add
//                     </Text>
//                   )}
//                   {btn.icon === 'center-focus-weak' && (
//                     <Text
//                       style={{
//                         color: theme.colors.foreground,
//                         fontSize: 9,
//                         fontWeight: tokens.fontWeight.semiBold,
//                         marginBottom: -2,
//                       }}>
//                       Scan
//                     </Text>
//                   )}
//                   <MaterialIcons
//                     name={btn.icon}
//                     size={btn.icon === 'add' || btn.icon === 'center-focus-weak' ? 20 : 26}
//                     color={theme.colors.foreground}
//                   />
//                 </Pressable>
//               </View>
//             </Animated.View>
//           ))}

//           {/* Main FAB (always visible) */}
//           <Animated.View
//             style={{
//               position: 'absolute',
//               bottom: 96,
//               right: 18,
//               transform: [{translateY: fabBounce}],
//             }}>
//             <View
//               style={{
//                 width: 54,
//                 height: 54,
//                 borderRadius: 32,
//                 borderWidth: 1,
//                 borderColor: theme.colors.foreground,
//                 backgroundColor: 'rgba(54, 54, 54, 0.44)',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//               }}>
//               <Pressable
//                 onPress={toggleFab}
//                 style={{
//                   width: '100%',
//                   height: '100%',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <Animated.View
//                   style={{
//                     transform: [
//                       {
//                         rotate: fabAnim.interpolate({
//                           inputRange: [0, 1],
//                           outputRange: ['0deg', '45deg'],
//                         }),
//                       },
//                     ],
//                   }}>
//                   <MaterialIcons
//                     name="add"
//                     size={32}
//                     color={theme.colors.foreground}
//                   />
//                 </Animated.View>
//               </Pressable>
//             </View>
//           </Animated.View>
//         </>

//         {/* Popover + Submenus */}
//         {menuVisible && (
//           <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
//             <View
//               style={{
//                 position: 'absolute',
//                 top: -60,
//                 left: 0,
//                 right: 0,
//                 bottom: 0,
//                 backgroundColor: 'transparent',
//                 zIndex: 9999,
//               }}>
//               <TouchableWithoutFeedback>
//                 <View>
//                   {menuView === 'main' && (
//                     <View style={styles.popover}>
//                       <TouchableOpacity
//                         style={styles.optionRow}
//                         onPress={() => {
//                           hSelect();
//                           openSubmenu('filter');
//                         }}>
//                         <MaterialIcons
//                           name="filter-list"
//                           size={24}
//                           color={theme.colors.foreground}
//                         />
//                         <Text style={styles.mainOptionText}>Filter</Text>
//                       </TouchableOpacity>

//                       <TouchableOpacity
//                         style={styles.optionRow}
//                         onPress={() => {
//                           hSelect();
//                           openSubmenu('sort');
//                         }}>
//                         <MaterialIcons
//                           name="sort"
//                           size={22}
//                           color={theme.colors.foreground}
//                         />
//                         <Text style={styles.mainOptionText}>Sort</Text>
//                       </TouchableOpacity>
//                     </View>
//                   )}

//                   {menuView === 'filter' && (
//                     <Animated.View
//                       style={[
//                         styles.submenu,
//                         {
//                           opacity: submenuOpacity,
//                           transform: [
//                             {
//                               scale: submenuOpacity.interpolate({
//                                 inputRange: [0, 1],
//                                 outputRange: [0.95, 1],
//                               }),
//                             },
//                           ],
//                         },
//                       ]}>
//                       <ScrollView
//                         showsVerticalScrollIndicator={false}
//                         contentContainerStyle={{paddingBottom: 8}}>
//                         {CATEGORY_META.map(cat => (
//                           <TouchableOpacity
//                             key={cat.value}
//                             onPress={() => {
//                               hSelect();
//                               setSelectedCategory(cat.value as any);
//                               setMenuVisible(false);
//                             }}
//                             style={styles.optionRow}>
//                             <MaterialIcons
//                               name={cat.icon}
//                               size={20}
//                               color={theme.colors.foreground}
//                             />
//                             <Text style={styles.optionText}>{cat.label}</Text>
//                           </TouchableOpacity>
//                         ))}
//                       </ScrollView>
//                     </Animated.View>
//                   )}

//                   {menuView === 'sort' && (
//                     <Animated.View
//                       style={[
//                         styles.submenu,
//                         {
//                           opacity: submenuOpacity,
//                           transform: [
//                             {
//                               scale: submenuOpacity.interpolate({
//                                 inputRange: [0, 1],
//                                 outputRange: [0.95, 1],
//                               }),
//                             },
//                           ],
//                         },
//                       ]}>
//                       <ScrollView
//                         showsVerticalScrollIndicator={false}
//                         contentContainerStyle={{paddingBottom: 8}}>
//                         {sortOptions.map(opt => (
//                           <TouchableOpacity
//                             key={opt.value}
//                             onPress={() => {
//                               hSelect();
//                               setSortOption(opt.value as any);
//                               setMenuVisible(false);
//                             }}
//                             style={styles.optionRow}>
//                             <MaterialIcons
//                               name="sort"
//                               size={20}
//                               color={theme.colors.foreground}
//                             />
//                             <Text style={styles.optionText}>{opt.label}</Text>
//                           </TouchableOpacity>
//                         ))}
//                       </ScrollView>
//                     </Animated.View>
//                   )}
//                 </View>
//               </TouchableWithoutFeedback>
//             </View>
//           </TouchableWithoutFeedback>
//         )}

//         {/* Edit Modal */}
//         {selectedItemToEdit && showEditModal && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 0,
//               left: 0,
//               right: 0,
//               bottom: 0,
//               backgroundColor: 'rgba(0,0,0,0.5)',
//               justifyContent: 'center',
//               alignItems: 'center',
//               zIndex: 10000,
//               elevation: 30,
//             }}>
//             <TouchableWithoutFeedback onPress={() => setShowEditModal(false)}>
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 0,
//                   left: 0,
//                   right: 0,
//                   bottom: 0,
//                 }}
//               />
//             </TouchableWithoutFeedback>

//             <Animated.View
//               style={{
//                 padding: 24,
//                 borderRadius: 12,
//                 backgroundColor: theme.colors.surface,
//                 width: '90%',
//                 maxWidth: 720,
//                 opacity: screenFade,
//                 transform: [
//                   {
//                     scale: screenFade.interpolate({
//                       inputRange: [0, 1],
//                       outputRange: [0.8, 1],
//                     }),
//                   },
//                 ],
//               }}>
//               <TextInput
//                 value={editedName}
//                 onChangeText={setEditedName}
//                 placeholder="Name"
//                 style={styles.input}
//                 placeholderTextColor="#999"
//               />
//               <TextInput
//                 value={editedColor}
//                 onChangeText={setEditedColor}
//                 placeholder="Color"
//                 style={styles.input}
//                 placeholderTextColor="#999"
//               />

//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   if (selectedItemToEdit) {
//                     updateMutation.mutate({
//                       id: selectedItemToEdit.id,
//                       name: editedName || selectedItemToEdit.name,
//                       color: editedColor || selectedItemToEdit.color,
//                     });
//                     setShowEditModal(false);
//                     setSelectedItemToEdit(null);
//                   }
//                 }}
//                 style={{
//                   paddingVertical: 12,
//                   borderRadius: tokens.borderRadius.sm,
//                   alignItems: 'center',
//                   backgroundColor: theme.colors.primary,
//                   marginTop: 12,
//                 }}>
//                 <Text
//                   style={{
//                     fontSize: 16,
//                     fontWeight: tokens.fontWeight.semiBold,
//                     color: theme.colors.background,
//                   }}>
//                   Save Changes
//                 </Text>
//               </AppleTouchFeedback>

//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   Alert.alert(
//                     'Delete Item',
//                     'Are you sure you want to delete this item?',
//                     [
//                       {text: 'Cancel', style: 'cancel'},
//                       {
//                         text: 'Delete',
//                         style: 'destructive',
//                         onPress: () => {
//                           deleteMutation.mutate(selectedItemToEdit.id);
//                           setShowEditModal(false);
//                           setSelectedItemToEdit(null);
//                         },
//                       },
//                     ],
//                   );
//                 }}
//                 style={{
//                   backgroundColor: '#cc0000',
//                   padding: 12,
//                   borderRadius: 8,
//                   marginTop: 16,
//                 }}>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     textAlign: 'center',
//                     fontWeight: tokens.fontWeight.semiBold,
//                   }}>
//                   Delete Item
//                 </Text>
//               </AppleTouchFeedback>
//             </Animated.View>
//           </View>
//         )}
//       </Animated.View>
//     </SafeAreaView>
//   );
// }

///////////////////

// import React, {useState, useEffect, useMemo, useRef, useCallback} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   Dimensions,
//   TouchableOpacity,
//   TouchableWithoutFeedback,
//   TextInput,
//   Animated,
//   Easing,
//   Alert,
//   Pressable,
//   NativeSyntheticEvent,
//   NativeScrollEvent,
//   ScrollView,
// } from 'react-native';
// import {FlashList} from '@shopify/flash-list';
// import FastImage from 'react-native-fast-image';
// import {useAppTheme} from '../context/ThemeContext';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import {getInferredCategory} from '../utils/categoryUtils';
// import {MainCategory, Subcategory} from '../types/categoryTypes';
// import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
// import {useUUID} from '../context/UUIDContext';
// import {apiClient} from '../lib/apiClient';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {TooltipBubble} from '../components/ToolTip/ToolTip1';
// import LiquidGlassCard from '../components/LiquidGlassCard/LiquidGlassCard';
// import {useClosetVoiceCommands} from '../utils/VoiceUtils/VoiceContext';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';
// import {SafeAreaView} from 'react-native-safe-area-context';
// import {useSafeAreaInsets} from 'react-native-safe-area-context';

// const {width: SCREEN_WIDTH} = Dimensions.get('window');
// const NUM_COLUMNS = 2;
// const ITEM_SPACING = 12;
// const ITEM_WIDTH = (SCREEN_WIDTH - ITEM_SPACING * 3) / NUM_COLUMNS;
// const ITEM_HEIGHT = ITEM_WIDTH * 1.3;

// // Animated pressable with scale effect for images
// const ScalePressable = ({
//   children,
//   onPress,
//   onLongPress,
//   style,
// }: {
//   children: React.ReactNode;
//   onPress: () => void;
//   onLongPress?: () => void;
//   style?: any;
// }) => {
//   const scaleAnim = useRef(new Animated.Value(1)).current;

//   const handlePressIn = () => {
//     Animated.spring(scaleAnim, {
//       toValue: 0.96,
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
//       <Animated.View style={[style, {transform: [{scale: scaleAnim}]}]}>
//         {children}
//       </Animated.View>
//     </Pressable>
//   );
// };

// type WardrobeItem = {
//   id: string;
//   image_url: string;
//   thumbnailUrl?: string;
//   name: string;
//   color?: string;
//   main_category?: MainCategory | string;
//   subcategory?: Subcategory | string;
//   fit?: string;
//   size?: string;
//   brand?: string;
//   material?: string;
//   width?: number;
//   height?: number;
//   favorite?: boolean;
// };

// type Props = {
//   navigate: (screen: string, params?: any) => void;
// };

// const CATEGORY_META: Array<{
//   value: MainCategory | 'All';
//   label: string;
//   icon: string;
// }> = [
//   {value: 'All', label: 'All', icon: 'category'},
//   {value: 'Tops', label: 'Tops', icon: 'checkroom'},
//   {value: 'Bottoms', label: 'Bottoms', icon: 'drag-handle'},
//   {value: 'Outerwear', label: 'Outerwear', icon: 'ac-unit'},
//   {value: 'Shoes', label: 'Shoes', icon: 'hiking'},
//   {value: 'Accessories', label: 'Accessories', icon: 'watch'},
//   {value: 'Undergarments', label: 'Undergarments', icon: 'layers'},
//   {value: 'Activewear', label: 'Activewear', icon: 'fitness-center'},
//   {value: 'Formalwear', label: 'Formalwear', icon: 'work'},
//   {value: 'Loungewear', label: 'Loungewear', icon: 'weekend'},
//   {value: 'Sleepwear', label: 'Sleepwear', icon: 'hotel'},
//   {value: 'Swimwear', label: 'Swimwear', icon: 'pool'},
//   {value: 'Maternity', label: 'Maternity', icon: 'pregnant-woman'},
//   {value: 'Unisex', label: 'Unisex', icon: 'wc'},
//   {value: 'Costumes', label: 'Costumes', icon: 'theater-comedy'},
//   {value: 'TraditionalWear', label: 'Traditional Wear', icon: 'festival'},
// ];

// const sortOptions = [
//   {label: 'Name A-Z', value: 'az'},
//   {label: 'Name Z-A', value: 'za'},
//   {label: 'Favorites First', value: 'favorites'},
// ];

// type FlatListItem = {
//   type: 'header' | 'subheader' | 'item';
//   id: string;
//   mainCategory?: string;
//   subCategory?: string;
//   item?: WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory};
// };

// export default function ClosetScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();
//   const userId = useUUID();

//   const insets = useSafeAreaInsets();
//   const [swipeActive, setSwipeActive] = useState(false);
//   const scrollEnabled = !swipeActive;

//   // Sync scroll position with global nav for bottom nav hide/show
//   const handleScroll = useCallback(
//     (event: NativeSyntheticEvent<NativeScrollEvent>) => {
//       if (global.__navScrollY) {
//         global.__navScrollY.setValue(event.nativeEvent.contentOffset.y);
//       }
//     },
//     [],
//   );

//   const [selectedCategory, setSelectedCategory] = useState<
//     'All' | MainCategory
//   >('All');
//   const [sortOption, setSortOption] = useState<'az' | 'za' | 'favorites'>('az');

//   // Menu states
//   const [menuVisible, setMenuVisible] = useState(false);
//   const [menuView, setMenuView] = useState<'main' | 'filter' | 'sort'>('main');

//   const [showEditModal, setShowEditModal] = useState(false);
//   const [selectedItemToEdit, setSelectedItemToEdit] =
//     useState<WardrobeItem | null>(null);
//   const [editedName, setEditedName] = useState('');
//   const [editedColor, setEditedColor] = useState('');

//   const screenFade = useRef(new Animated.Value(0)).current;
//   const screenTranslate = useRef(new Animated.Value(50)).current;
//   const fabBounce = useRef(new Animated.Value(250)).current;

//   const submenuOpacity = useRef(new Animated.Value(0)).current;

//   useEffect(() => {
//     Animated.sequence([
//       Animated.timing(screenFade, {
//         toValue: 1,
//         duration: 800,
//         easing: Easing.out(Easing.exp),
//         useNativeDriver: true,
//       }),
//       Animated.spring(screenTranslate, {
//         toValue: 0,
//         speed: 2,
//         bounciness: 14,
//         useNativeDriver: true,
//       }),
//     ]).start();
//     Animated.spring(fabBounce, {
//       toValue: 0,
//       delay: 900,
//       speed: 2,
//       bounciness: 14,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   const {data: wardrobe = [], isLoading} = useQuery({
//     queryKey: ['wardrobe', userId],
//     queryFn: async () => {
//       const res = await apiClient.get('/wardrobe');
//       return res.data;
//     },
//     enabled: !!userId,
//     staleTime: 30000,
//   });

//   const hSelect = () =>
//     ReactNativeHapticFeedback.trigger('selection', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   const deleteMutation = useMutation({
//     mutationFn: async (id: string) => {
//       await apiClient.delete(`/wardrobe/${id}`);
//     },
//     onMutate: async (id: string) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old => old?.filter(item => item.id !== id) || [],
//       );
//       return {prev};
//     },
//     onError: (_err, _id, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const updateMutation = useMutation({
//     mutationFn: async ({
//       id,
//       name,
//       color,
//     }: {
//       id: string;
//       name?: string;
//       color?: string;
//     }) => {
//       await apiClient.put(`/wardrobe/${id}`, {name, color});
//     },
//     onMutate: async ({id, name, color}) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old =>
//           old?.map(item =>
//             item.id === id
//               ? {...item, name: name ?? item.name, color: color ?? item.color}
//               : item,
//           ) || [],
//       );
//       return {prev};
//     },
//     onError: (_err, _vars, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const filtered = useMemo(() => {
//     return (wardrobe as WardrobeItem[])
//       .map(item => {
//         const inferred = getInferredCategory(item.name);
//         const effectiveMain: MainCategory | undefined =
//           (item.main_category as MainCategory) ?? inferred?.main;
//         return {...item, inferredCategory: inferred, effectiveMain};
//       })
//       .filter(item => {
//         if (selectedCategory === 'All') return true;
//         return item.effectiveMain === selectedCategory;
//       })
//       .sort((a, b) => {
//         if (sortOption === 'az') return a.name.localeCompare(b.name);
//         if (sortOption === 'za') return b.name.localeCompare(a.name);
//         if (sortOption === 'favorites')
//           return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
//         return 0;
//       });
//   }, [wardrobe, selectedCategory, sortOption]);

//   // Flatten categorized items for FlashList
//   const flatListData = useMemo(() => {
//     const result: FlatListItem[] = [];
//     const categorized: Record<
//       string,
//       Record<
//         string,
//         (WardrobeItem & {inferredCategory?: any; effectiveMain?: MainCategory})[]
//       >
//     > = {};

//     for (const item of filtered) {
//       const main =
//         (item.main_category as string) ||
//         item.inferredCategory?.main ||
//         'Uncategorized';
//       const sub =
//         (item.subcategory as string) ||
//         item.inferredCategory?.sub ||
//         'General';
//       if (!categorized[main]) categorized[main] = {};
//       if (!categorized[main][sub]) categorized[main][sub] = [];
//       categorized[main][sub].push(item);
//     }

//     for (const [mainCategory, subMap] of Object.entries(categorized)) {
//       result.push({
//         type: 'header',
//         id: `header-${mainCategory}`,
//         mainCategory,
//       });

//       for (const [subCategory, items] of Object.entries(subMap)) {
//         result.push({
//           type: 'subheader',
//           id: `subheader-${mainCategory}-${subCategory}`,
//           mainCategory,
//           subCategory,
//         });

//         for (const item of items) {
//           result.push({
//             type: 'item',
//             id: `item-${item.id}`,
//             mainCategory,
//             subCategory,
//             item,
//           });
//         }
//       }
//     }

//     return result;
//   }, [filtered]);

//   // FAB state
//   const [fabOpen, setFabOpen] = useState(false);
//   const fabAnim = useRef(new Animated.Value(0)).current;

//   const toggleFab = () => {
//     ReactNativeHapticFeedback.trigger('impactLight', {
//       enableVibrateFallback: true,
//     });
//     Animated.spring(fabAnim, {
//       toValue: fabOpen ? 0 : 1,
//       useNativeDriver: false,
//       friction: 6,
//       tension: 40,
//     }).start();
//     setFabOpen(!fabOpen);
//   };

//   const fabOpacity = fabAnim.interpolate({
//     inputRange: [0, 0.6, 1],
//     outputRange: [0, 0.9, 1],
//   });

//   const favoriteMutation = useMutation({
//     mutationFn: async ({id, favorite}: {id: string; favorite: boolean}) => {
//       await apiClient.put(`/wardrobe/favorite/${id}`, {favorite});
//     },
//     onMutate: async ({id, favorite}) => {
//       await queryClient.cancelQueries({queryKey: ['wardrobe', userId]});
//       const prev = queryClient.getQueryData<WardrobeItem[]>([
//         'wardrobe',
//         userId,
//       ]);
//       queryClient.setQueryData<WardrobeItem[]>(
//         ['wardrobe', userId],
//         old =>
//           old?.map(item => (item.id === id ? {...item, favorite} : item)) || [],
//       );
//       return {prev};
//     },
//     onError: (err, _, context) => {
//       if (context?.prev) {
//         queryClient.setQueryData(['wardrobe', userId], context.prev);
//       }
//     },
//     onSettled: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe', userId]});
//     },
//   });

//   const styles = StyleSheet.create({
//     buttonRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       justifyContent: 'flex-end',
//       marginTop: 10,
//     },
//     popover: {
//       position: 'absolute',
//       top: insets.top + 115,
//       right: 20,
//       width: 220,
//       backgroundColor: theme.colors.surface,
//       borderRadius: 16,
//       paddingVertical: 12,
//       paddingHorizontal: 14,
//       elevation: 20,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowOffset: {width: 0, height: 4},
//       shadowRadius: 14,
//       zIndex: 9999,
//     },
//     submenu: {
//       position: 'absolute',
//       top: insets.top + 115,
//       right: 16,
//       width: 320,
//       maxHeight: Dimensions.get('window').height * 0.7,
//       backgroundColor: theme.colors.surface,
//       borderRadius: 16,
//       paddingVertical: 16,
//       paddingHorizontal: 18,
//       elevation: 20,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowOffset: {width: 0, height: 4},
//       shadowRadius: 14,
//       zIndex: 9999,
//     },
//     optionRow: {
//       paddingVertical: 10,
//       flexDirection: 'row',
//       alignItems: 'center',
//     },
//     optionText: {
//       fontSize: 16,
//       color: theme.colors.foreground,
//       marginLeft: 8,
//     },
//     mainOptionText: {
//       fontSize: 17,
//       color: theme.colors.foreground,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: theme.colors.inputBorder,
//       borderRadius: 8,
//       padding: 12,
//       marginBottom: 12,
//       color: theme.colors.foreground,
//       backgroundColor: theme.colors.background,
//     },
//     itemContainer: {
//       width: ITEM_WIDTH,
//       marginBottom: 15,
//     },
//     itemImage: {
//       width: '100%',
//       height: ITEM_HEIGHT,
//       backgroundColor: theme.colors.surface,
//       borderTopLeftRadius: tokens.borderRadius.sm,
//       borderTopRightRadius: tokens.borderRadius.sm,
//     },
//     itemRow: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'space-between',
//       paddingHorizontal: ITEM_SPACING,
//     },
//   });

//   const openSubmenu = (view: 'filter' | 'sort') => {
//     setMenuView(view);
//     submenuOpacity.setValue(0);
//     Animated.timing(submenuOpacity, {
//       toValue: 1,
//       duration: 180,
//       useNativeDriver: true,
//     }).start();
//   };

//   useClosetVoiceCommands(
//     openSubmenu,
//     setMenuVisible,
//     setSelectedCategory,
//     setSortOption,
//   );

//   const renderItem = useCallback(
//     ({item: listItem}: {item: FlatListItem}) => {
//       if (listItem.type === 'header') {
//         return (
//           <View style={globalStyles.section}>
//             <Animated.Text
//               style={[
//                 globalStyles.sectionTitle5,
//                 {
//                   transform: [
//                     {
//                       translateY: screenFade.interpolate({
//                         inputRange: [0, 1],
//                         outputRange: [20, 0],
//                       }),
//                     },
//                   ],
//                   opacity: screenFade,
//                 },
//               ]}>
//               {listItem.mainCategory}
//             </Animated.Text>
//           </View>
//         );
//       }

//       if (listItem.type === 'subheader') {
//         return (
//           <View style={{paddingHorizontal: ITEM_SPACING}}>
//             <Text style={[globalStyles.title3]}>{listItem.subCategory}</Text>
//           </View>
//         );
//       }

//       const item = listItem.item!;
//       const imageUri = item.thumbnailUrl ?? item.image_url;

//       return (
//         <View style={styles.itemContainer}>
//           <ScalePressable
//             style={globalStyles.outfitCard4}
//             onPress={() => navigate('ItemDetail', {itemId: item.id, item})}
//             onLongPress={() => {
//               setEditedName(item.name ?? '');
//               setEditedColor(item.color ?? '');
//               setSelectedItemToEdit(item);
//               setShowEditModal(true);
//             }}>
//             <View
//               style={{
//                 width: '100%',
//                 backgroundColor: theme.colors.surface,
//               }}>
//               <FastImage
//                 source={{
//                   uri: imageUri,
//                   priority: FastImage.priority.normal,
//                   cache: FastImage.cacheControl.immutable,
//                 }}
//                 style={globalStyles.image10}
//                 resizeMode={FastImage.resizeMode.cover}
//               />
//             </View>
//             {/* Favorite */}
//             <View
//               style={{
//                 position: 'absolute',
//                 top: 8,
//                 right: 8,
//                 zIndex: 10,
//                 padding: 4,
//               }}>
//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() =>
//                   favoriteMutation.mutate({
//                     id: item.id,
//                     favorite: !item.favorite,
//                   })
//                 }>
//                 <MaterialIcons
//                   name="favorite"
//                   size={28}
//                   color={item.favorite ? 'red' : theme.colors.inputBorder}
//                 />
//               </AppleTouchFeedback>
//             </View>

//             {/* Labels */}
//             <View style={globalStyles.labelContainer}>
//               <Text
//                 style={[globalStyles.cardLabel]}
//                 numberOfLines={1}
//                 ellipsizeMode="tail">
//                 {item.name}
//               </Text>
//               <Text style={[globalStyles.cardSubLabel]} numberOfLines={1}>
//                 {listItem.subCategory}
//               </Text>
//             </View>

//             {/* Try On */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               onPress={() =>
//                 navigate('TryOnOverlay', {
//                   outfit: {
//                     top: {
//                       name: item.name,
//                       imageUri: item.image_url,
//                     },
//                   },
//                   userPhotoUri: Image.resolveAssetSource(
//                     require('../assets/images/full-body-temp1.png'),
//                   ).uri,
//                 })
//               }
//               style={{
//                 position: 'absolute',
//                 top: 10,
//                 left: 8,
//                 backgroundColor: 'black',
//                 paddingHorizontal: 10,
//                 paddingVertical: 4,
//                 borderRadius: 8,
//               }}>
//               <Text
//                 style={{
//                   color: theme.colors.foreground,
//                   fontSize: 14,
//                   fontWeight: tokens.fontWeight.medium,
//                 }}>
//                 Try On
//               </Text>
//             </AppleTouchFeedback>
//           </ScalePressable>
//         </View>
//       );
//     },
//     [
//       globalStyles,
//       screenFade,
//       theme,
//       navigate,
//       favoriteMutation,
//       styles.itemContainer,
//     ],
//   );

//   const getItemType = useCallback((item: FlatListItem) => {
//     return item.type;
//   }, []);

//   const keyExtractor = useCallback((item: FlatListItem) => item.id, []);

//   // Estimate item sizes for FlashList optimization
//   const overrideItemLayout = useCallback(
//     (
//       layout: {span?: number; size?: number},
//       item: FlatListItem,
//     ): void => {
//       if (item.type === 'header') {
//         layout.size = 60;
//         layout.span = NUM_COLUMNS;
//       } else if (item.type === 'subheader') {
//         layout.size = 40;
//         layout.span = NUM_COLUMNS;
//       } else {
//         layout.size = ITEM_HEIGHT + 80;
//         layout.span = 1;
//       }
//     },
//     [],
//   );

//   return (
//     <SafeAreaView
//       edges={['top']}
//       style={[
//         globalStyles.screen,
//         globalStyles.container,
//         {
//           flex: 1,
//           backgroundColor: theme.colors.background,
//           paddingBottom: 0,
//         },
//       ]}>
//       <Animated.View
//         style={{
//           flex: 1,
//           opacity: screenFade,
//           transform: [{translateY: screenTranslate}],
//         }}>
//         <View
//           style={{
//             height: Math.max(insets.top, 44),
//             backgroundColor: theme.colors.background,
//           }}
//         />
//         <Text style={globalStyles.header}>Wardrobe</Text>

//         {/* Header buttons */}
//         <View style={globalStyles.section}>
//           <View style={[styles.buttonRow]}>
//             <View style={{marginRight: 8}}>
//               <AppleTouchFeedback
//                 style={[
//                   globalStyles.buttonPrimary,
//                   {
//                     paddingHorizontal: 28,
//                     minWidth: 180,
//                     alignSelf: 'center',
//                     flexShrink: 0,
//                   },
//                 ]}
//                 hapticStyle="impactMedium"
//                 onPress={() => navigate('OutfitBuilder')}>
//                 <Text style={globalStyles.buttonPrimaryText}>
//                   + Build An Outfit
//                 </Text>
//               </AppleTouchFeedback>
//             </View>

//             {/* Unified Menu Trigger */}
//             <AppleTouchFeedback
//               hapticStyle="impactLight"
//               style={{
//                 paddingHorizontal: 7,
//                 paddingVertical: 8,
//                 borderRadius: tokens.borderRadius.sm,
//                 backgroundColor: theme.colors.button1,
//                 elevation: 2,
//               }}
//               onPress={() => {
//                 setMenuVisible(prev => !prev);
//                 setMenuView('main');
//               }}>
//               <MaterialIcons
//                 name="filter-list"
//                 size={33}
//                 color={theme.colors.buttonText1}
//               />
//             </AppleTouchFeedback>
//           </View>
//         </View>

//         {/* Empty state */}
//         {!isLoading && wardrobe.length === 0 && (
//           <View style={{flexDirection: 'row', alignSelf: 'center'}}>
//             <Text style={globalStyles.missingDataMessage1}>
//               No wardrobe items found.
//             </Text>
//             <View style={{alignSelf: 'flex-start'}}>
//               <TooltipBubble
//                 message="You haven't uploaded any wardrobe items yet. Tap the + button at the bottom to start adding your personal wardrobe inventory."
//                 position="top"
//               />
//             </View>
//           </View>
//         )}

//         {/* Wardrobe Grid - FlashList */}
//         <FlashList
//           data={flatListData}
//           renderItem={renderItem}
//           keyExtractor={keyExtractor}
//           getItemType={getItemType}
//           overrideItemLayout={overrideItemLayout}
//           numColumns={NUM_COLUMNS}
//           showsVerticalScrollIndicator={false}
//           onScroll={handleScroll}
//           scrollEventThrottle={16}
//           drawDistance={ITEM_HEIGHT * 2}
//           contentContainerStyle={{
//             paddingHorizontal: ITEM_SPACING / 2,
//             paddingBottom: 120,
//           }}
//         />

//         <>
//           {/* Floating Mini FABs */}
//           {[
//             {icon: 'search', onPress: () => navigate('Search'), offset: 3},
//             {
//               icon: 'qr-code-scanner',
//               onPress: () => navigate('BarcodeScannerScreen'),
//               offset: 2,
//             },
//             {icon: 'add', onPress: () => navigate('AddItem'), offset: 1},
//           ].map((btn, index) => (
//             <Animated.View
//               key={index}
//               style={{
//                 position: 'absolute',
//                 bottom: 97,
//                 right: -2,
//                 opacity: fabOpacity,

//                 transform: [
//                   {
//                     translateX: fabAnim.interpolate({
//                       inputRange: [0, 1],
//                       outputRange: [0, -70 * (btn.offset + 0.3)],
//                     }),
//                   },
//                   {scale: fabAnim},
//                 ],
//               }}>
//               <View
//                 style={{
//                   width: 50,
//                   height: 50,
//                   borderRadius: 26,
//                   borderWidth: 1,
//                   borderColor: theme.colors.foreground,
//                   backgroundColor: 'rgba(54, 54, 54, 0.44)',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <Pressable
//                   onPress={() => {
//                     toggleFab();
//                     btn.onPress();
//                   }}
//                   style={{
//                     width: '100%',
//                     height: '100%',
//                     alignItems: 'center',
//                     justifyContent: 'center',
//                   }}>
//                   <MaterialIcons
//                     name={btn.icon}
//                     size={26}
//                     color={theme.colors.foreground}
//                   />
//                 </Pressable>
//               </View>
//             </Animated.View>
//           ))}

//           {/* Main FAB (always visible) */}
//           <Animated.View
//             style={{
//               position: 'absolute',
//               bottom: 96,
//               right: 18,
//               transform: [{translateY: fabBounce}],
//             }}>
//             <View
//               style={{
//                 width: 54,
//                 height: 54,
//                 borderRadius: 32,
//                 borderWidth: 1,
//                 borderColor: theme.colors.foreground,
//                 backgroundColor: 'rgba(54, 54, 54, 0.44)',
//                 alignItems: 'center',
//                 justifyContent: 'center',
//               }}>
//               <Pressable
//                 onPress={toggleFab}
//                 style={{
//                   width: '100%',
//                   height: '100%',
//                   alignItems: 'center',
//                   justifyContent: 'center',
//                 }}>
//                 <Animated.View
//                   style={{
//                     transform: [
//                       {
//                         rotate: fabAnim.interpolate({
//                           inputRange: [0, 1],
//                           outputRange: ['0deg', '45deg'],
//                         }),
//                       },
//                     ],
//                   }}>
//                   <MaterialIcons
//                     name="add"
//                     size={32}
//                     color={theme.colors.foreground}
//                   />
//                 </Animated.View>
//               </Pressable>
//             </View>
//           </Animated.View>
//         </>

//         {/* Popover + Submenus */}
//         {menuVisible && (
//           <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
//             <View
//               style={{
//                 position: 'absolute',
//                 top: 0,
//                 left: 0,
//                 right: 0,
//                 bottom: 0,
//                 backgroundColor: 'transparent',
//                 zIndex: 9999,
//               }}>
//               <TouchableWithoutFeedback>
//                 <>
//                   {menuView === 'main' && (
//                     <View style={styles.popover}>
//                       <TouchableOpacity
//                         style={styles.optionRow}
//                         onPress={() => {
//                           hSelect();
//                           openSubmenu('filter');
//                         }}>
//                         <MaterialIcons
//                           name="filter-list"
//                           size={24}
//                           color={theme.colors.foreground}
//                         />
//                         <Text style={styles.mainOptionText}>Filter</Text>
//                       </TouchableOpacity>

//                       <TouchableOpacity
//                         style={styles.optionRow}
//                         onPress={() => {
//                           hSelect();
//                           openSubmenu('sort');
//                         }}>
//                         <MaterialIcons
//                           name="sort"
//                           size={22}
//                           color={theme.colors.foreground}
//                         />
//                         <Text style={styles.mainOptionText}>Sort</Text>
//                       </TouchableOpacity>
//                     </View>
//                   )}

//                   {menuView === 'filter' && (
//                     <Animated.View
//                       style={[
//                         styles.submenu,
//                         {
//                           opacity: submenuOpacity,
//                           transform: [
//                             {
//                               scale: submenuOpacity.interpolate({
//                                 inputRange: [0, 1],
//                                 outputRange: [0.95, 1],
//                               }),
//                             },
//                           ],
//                         },
//                       ]}>
//                       <ScrollView
//                         showsVerticalScrollIndicator={false}
//                         contentContainerStyle={{paddingBottom: 8}}>
//                         {CATEGORY_META.map(cat => (
//                           <TouchableOpacity
//                             key={cat.value}
//                             onPress={() => {
//                               hSelect();
//                               setSelectedCategory(cat.value as any);
//                               setMenuVisible(false);
//                             }}
//                             style={styles.optionRow}>
//                             <MaterialIcons
//                               name={cat.icon}
//                               size={20}
//                               color={theme.colors.foreground}
//                             />
//                             <Text style={styles.optionText}>{cat.label}</Text>
//                           </TouchableOpacity>
//                         ))}
//                       </ScrollView>
//                     </Animated.View>
//                   )}

//                   {menuView === 'sort' && (
//                     <Animated.View
//                       style={[
//                         styles.submenu,
//                         {
//                           opacity: submenuOpacity,
//                           transform: [
//                             {
//                               scale: submenuOpacity.interpolate({
//                                 inputRange: [0, 1],
//                                 outputRange: [0.95, 1],
//                               }),
//                             },
//                           ],
//                         },
//                       ]}>
//                       <ScrollView
//                         showsVerticalScrollIndicator={false}
//                         contentContainerStyle={{paddingBottom: 8}}>
//                         {sortOptions.map(opt => (
//                           <TouchableOpacity
//                             key={opt.value}
//                             onPress={() => {
//                               hSelect();
//                               setSortOption(opt.value as any);
//                               setMenuVisible(false);
//                             }}
//                             style={styles.optionRow}>
//                             <MaterialIcons
//                               name="sort"
//                               size={20}
//                               color={theme.colors.foreground}
//                             />
//                             <Text style={styles.optionText}>{opt.label}</Text>
//                           </TouchableOpacity>
//                         ))}
//                       </ScrollView>
//                     </Animated.View>
//                   )}
//                 </>
//               </TouchableWithoutFeedback>
//             </View>
//           </TouchableWithoutFeedback>
//         )}

//         {/* Edit Modal */}
//         {selectedItemToEdit && showEditModal && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 0,
//               left: 0,
//               right: 0,
//               bottom: 0,
//               backgroundColor: 'rgba(0,0,0,0.5)',
//               justifyContent: 'center',
//               alignItems: 'center',
//               zIndex: 10000,
//               elevation: 30,
//             }}>
//             <TouchableWithoutFeedback onPress={() => setShowEditModal(false)}>
//               <View
//                 style={{
//                   position: 'absolute',
//                   top: 0,
//                   left: 0,
//                   right: 0,
//                   bottom: 0,
//                 }}
//               />
//             </TouchableWithoutFeedback>

//             <Animated.View
//               style={{
//                 padding: 24,
//                 borderRadius: 12,
//                 backgroundColor: theme.colors.surface,
//                 width: '90%',
//                 maxWidth: 720,
//                 opacity: screenFade,
//                 transform: [
//                   {
//                     scale: screenFade.interpolate({
//                       inputRange: [0, 1],
//                       outputRange: [0.8, 1],
//                     }),
//                   },
//                 ],
//               }}>
//               <TextInput
//                 value={editedName}
//                 onChangeText={setEditedName}
//                 placeholder="Name"
//                 style={styles.input}
//                 placeholderTextColor="#999"
//               />
//               <TextInput
//                 value={editedColor}
//                 onChangeText={setEditedColor}
//                 placeholder="Color"
//                 style={styles.input}
//                 placeholderTextColor="#999"
//               />

//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   if (selectedItemToEdit) {
//                     updateMutation.mutate({
//                       id: selectedItemToEdit.id,
//                       name: editedName || selectedItemToEdit.name,
//                       color: editedColor || selectedItemToEdit.color,
//                     });
//                     setShowEditModal(false);
//                     setSelectedItemToEdit(null);
//                   }
//                 }}
//                 style={{
//                   paddingVertical: 12,
//                   borderRadius: tokens.borderRadius.sm,
//                   alignItems: 'center',
//                   backgroundColor: theme.colors.primary,
//                   marginTop: 12,
//                 }}>
//                 <Text
//                   style={{
//                     fontSize: 16,
//                     fontWeight: tokens.fontWeight.semiBold,
//                     color: theme.colors.background,
//                   }}>
//                   Save Changes
//                 </Text>
//               </AppleTouchFeedback>

//               <AppleTouchFeedback
//                 hapticStyle="impactLight"
//                 onPress={() => {
//                   Alert.alert(
//                     'Delete Item',
//                     'Are you sure you want to delete this item?',
//                     [
//                       {text: 'Cancel', style: 'cancel'},
//                       {
//                         text: 'Delete',
//                         style: 'destructive',
//                         onPress: () => {
//                           deleteMutation.mutate(selectedItemToEdit.id);
//                           setShowEditModal(false);
//                           setSelectedItemToEdit(null);
//                         },
//                       },
//                     ],
//                   );
//                 }}
//                 style={{
//                   backgroundColor: '#cc0000',
//                   padding: 12,
//                   borderRadius: 8,
//                   marginTop: 16,
//                 }}>
//                 <Text
//                   style={{
//                     color: '#fff',
//                     textAlign: 'center',
//                     fontWeight: tokens.fontWeight.semiBold,
//                   }}>
//                   Delete Item
//                 </Text>
//               </AppleTouchFeedback>
//             </Animated.View>
//           </View>
//         )}
//       </Animated.View>
//     </SafeAreaView>
//   );
// }
