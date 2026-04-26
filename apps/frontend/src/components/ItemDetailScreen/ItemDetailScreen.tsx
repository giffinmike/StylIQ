// apps/frontend/screens/ItemDetailScreen.tsx
import React, {useState, useEffect, useMemo, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TextInput,
  ScrollView,
  Pressable,
  Alert,
  Animated,
  Easing,
} from 'react-native';
import {useAppTheme} from '../../context/ThemeContext';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {API_BASE_URL} from '../../config/api';
import {getAccessToken} from '../../utils/auth';
import {mockClothingItems} from '../../components/mockClothingItems/mockClothingItems';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {tokens} from '../../styles/tokens/tokens';
import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {ActivityIndicator} from 'react-native';
import {fontScale, moderateScale} from '../../utils/scale';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import FieldPicker, {
  MAIN_CATEGORIES,
  FIT_OPTIONS,
  PATTERN_OPTIONS,
  PATTERN_SCALE_OPTIONS,
  SEASONALITY_OPTIONS,
  LAYERING_OPTIONS,
  DRESS_CODE_OPTIONS,
  ANCHOR_ROLE_OPTIONS,
  COLOR_FAMILY_OPTIONS,
  OCCASION_OPTIONS,
} from '../FieldPicker/FieldPicker';
import categoriesJson from '../../assets/data/categories.json';

type Props = {
  route: any;
  navigation: any;
};

// ─────────────────────────────────────────────
// Normalizers (mirrored from AddItemScreen)
// ─────────────────────────────────────────────
const normalizePatternScale = (
  raw: string,
): 'subtle' | 'medium' | 'bold' | undefined => {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n <= 0 ? 'subtle' : n === 1 ? 'medium' : 'bold';
  }
  if (['subtle', 'small', 'micro'].includes(s)) return 'subtle';
  if (['medium', 'mid'].includes(s)) return 'medium';
  if (['bold', 'large', 'big'].includes(s)) return 'bold';
  return undefined;
};

const normalizeSeasonality = (raw: string) => {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (['ss', 'spring', 'summer', 'spring/summer', 's/s'].includes(s))
    return 'SS';
  if (['fw', 'fall', 'autumn', 'winter', 'fall/winter', 'f/w'].includes(s))
    return 'FW';
  if (
    [
      'all',
      'allseason',
      'all-season',
      'all season',
      'year-round',
      'year round',
      'all_season',
    ].includes(s)
  )
    return 'ALL_SEASON';
  return raw;
};

const normalizeLayering = (raw: string) => {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (['base', 'baselayer'].includes(s)) return 'BASE';
  if (['mid', 'midlayer'].includes(s)) return 'MID';
  if (['shell', 'outer', 'outerwear', 'jacket'].includes(s)) return 'SHELL';
  if (['accent', 'accessory', 'acc'].includes(s)) return 'ACCENT';
  return raw;
};

export default function ItemDetailScreen({route, navigation}: Props) {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const queryClient = useQueryClient();

  const insets = useSafeAreaInsets();

  // Animation - buttery smooth entrance
  const slideUpAnim = useRef(new Animated.Value(120)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideUpAnim, {
        toValue: 0,
        duration: 550,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideUpAnim, opacityAnim]);

  const {itemId, item: routeItem} = route.params;
  const item = useMemo(
    () => routeItem ?? mockClothingItems.find(i => i.id === itemId),
    [routeItem, itemId],
  );

  const hSuccess = () =>
    ReactNativeHapticFeedback.trigger('notificationSuccess', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
  const hError = () =>
    ReactNativeHapticFeedback.trigger('notificationError', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });

  // Core/base
  const [name, setName] = useState('');
  const [category, setCategory] = useState(''); // ↔ main_category
  const [subcategory, setSubcategory] = useState('');
  const [color, setColor] = useState('');
  const [material, setMaterial] = useState('');
  const [fit, setFit] = useState('');
  const [size, setSize] = useState('');
  const [brand, setBrand] = useState('');
  const [tags, setTags] = useState(''); // comma-separated UI
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [touchingUp, setTouchingUp] = useState(false);
  const [removingBg, setRemovingBg] = useState(false);

  // Enriched
  const [pattern, setPattern] = useState('');
  const [patternScale, setPatternScale] = useState(''); // text input; normalized on save
  const [seasonality, setSeasonality] = useState(''); // normalized to SS/FW/ALL_SEASON
  const [layering, setLayering] = useState(''); // normalized to BASE/MID/SHELL/ACCENT

  // Derived fields from AddItemScreen
  const [dressCode, setDressCode] = useState(''); // 'UltraCasual' | 'Casual' | ...
  const [anchorRole, setAnchorRole] = useState(''); // 'Hero' | 'Neutral' | 'Connector'
  const [colorFamily, setColorFamily] = useState(''); // e.g. Navy, Black, White
  const [occasionTags, setOccasionTags] = useState(''); // comma UI → array: Work,DateNight,...

  useEffect(() => {
    if (!item) return;

    // handle snake_case and camelCase
    setName(item.name ?? item.ai_title ?? '');
    setCategory(item.main_category ?? item.mainCategory ?? '');
    setSubcategory(item.subcategory ?? item.subCategory ?? '');
    setColor(item.color ?? '');
    setMaterial(item.material ?? '');
    setFit(item.fit ?? '');
    setSize(item.size ?? item.size_label ?? '');
    setBrand(item.brand ?? '');

    const _tags: string[] = Array.isArray(item.tags)
      ? item.tags
      : typeof (item.tags as any) === 'string'
        ? (item.tags as any)
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];
    setTags(_tags.join(', '));

    setPattern(item.pattern ?? '');
    // pattern_scale may be number or enum; show as text
    const ps = item.pattern_scale;
    setPatternScale(
      ps === 0
        ? '0'
        : ps === 1
          ? '1'
          : ps === 2
            ? '2'
            : typeof ps === 'string'
              ? ps
              : (ps ?? '').toString(),
    );

    setSeasonality(item.seasonality ?? '');
    setLayering(item.layering ?? '');

    // derived
    setDressCode(item.dress_code ?? '');
    setAnchorRole(item.anchor_role ?? '');
    setColorFamily(item.color_family ?? '');
    const _occTags: string[] = Array.isArray(item.occasion_tags)
      ? item.occasion_tags
      : [];
    setOccasionTags(_occTags.join(', '));
  }, [item]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      setSaving(true); // 🟢 start spinner
      if (!item?.id) throw new Error('Missing item ID');

      const normPatternScale = normalizePatternScale(patternScale || '');
      const normSeasonality = normalizeSeasonality(seasonality || '');
      const normLayering = normalizeLayering(layering || '');

      const payload = {
        name,
        color,
        main_category: category,
        subcategory,
        material,
        fit,
        size,
        brand,
        pattern,
        pattern_scale: normPatternScale,
        seasonality: normSeasonality,
        layering: normLayering,
        tags: tags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean),
        dress_code: dressCode || undefined,
        anchor_role: anchorRole || undefined,
        color_family: colorFamily || undefined,
        occasion_tags: occasionTags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean),
      };

      const accessToken = await getAccessToken();
      const res = await fetch(`${API_BASE_URL}/wardrobe/${item.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(
          `Failed to update item ${res.status}: ${txt || res.statusText}`,
        );
      }
      return res.json();
    },
    onSuccess: () => {
      hSuccess();
      setSaving(false); // 🔴 stop spinner
      queryClient.invalidateQueries({queryKey: ['wardrobe']});
      navigation.goBack();
    },
    onError: () => {
      hError();
      setSaving(false); // 🔴 stop spinner
      Alert.alert('Error', 'Failed to update item.');
    },
  });

  // const deleteMutation = useMutation({
  //   mutationFn: async () => {
  //     if (!item?.id || !item?.user_id || !item?.image_url) {
  //       throw new Error('Missing item info');
  //     }
  //     const res = await fetch(`${API_BASE_URL}/wardrobe`, {
  //       method: 'DELETE',
  //       headers: {'Content-Type': 'application/json'},
  //       body: JSON.stringify({
  //         item_id: item.id,
  //         user_id: item.user_id,
  //         image_url: item.image_url,
  //       }),
  //     });
  //     if (!res.ok) throw new Error('Failed to delete item');
  //     return item.id;
  //   },
  //   onSuccess: () => {
  //     queryClient.invalidateQueries({queryKey: ['wardrobe']});
  //     navigation.goBack();
  //   },
  //   onError: () => {
  //     Alert.alert('Error', 'Failed to delete item.');
  //   },
  // });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      setDeleting(true); // 🟢 start spinner
      if (!item?.id || !item?.user_id || !item?.image_url) {
        throw new Error('Missing item info');
      }
      const accessToken = await getAccessToken();
      const res = await fetch(`${API_BASE_URL}/wardrobe`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          item_id: item.id,
          user_id: item.user_id,
          image_url: item.image_url,
        }),
      });
      if (!res.ok) throw new Error('Failed to delete item');
      return item.id;
    },
    onSuccess: () => {
      setDeleting(false); // 🔴 stop spinner
      queryClient.invalidateQueries({queryKey: ['wardrobe']});
      navigation.goBack();
    },
    onError: () => {
      setDeleting(false); // 🔴 stop spinner
      Alert.alert('Error', 'Failed to delete item.');
    },
  });

  const handleDelete = () => {
    if (!item?.id) return;
    Alert.alert('Delete Item', 'Are you sure you want to delete this item?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteMutation.mutate(),
      },
    ]);
  };

  const touchUpMutation = useMutation({
    mutationFn: async () => {
      setTouchingUp(true);
      if (!item?.id) throw new Error('Missing item ID');
      const accessToken = await getAccessToken();
      const res = await fetch(`${API_BASE_URL}/wardrobe/${item.id}/touch-up`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(
          `Touch-up failed ${res.status}: ${txt || res.statusText}`,
        );
      }
      return res.json();
    },
    onSuccess: () => {
      hSuccess();
      setTouchingUp(false);
      queryClient.invalidateQueries({queryKey: ['wardrobe']});
      Alert.alert('Success', 'Image has been touched up successfully.');
    },
    onError: (err: any) => {
      hError();
      setTouchingUp(false);
      Alert.alert('Error', err?.message || 'Failed to touch up image.');
    },
  });

  const removeBackgroundMutation = useMutation({
    mutationFn: async () => {
      setRemovingBg(true);
      if (!item?.id) throw new Error('Missing item ID');
      const accessToken = await getAccessToken();
      const res = await fetch(
        `${API_BASE_URL}/wardrobe/${item.id}/remove-background`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(
          `Remove background failed ${res.status}: ${txt || res.statusText}`,
        );
      }
      return res.json();
    },
    onSuccess: () => {
      hSuccess();
      setRemovingBg(false);
      queryClient.invalidateQueries({queryKey: ['wardrobe']});
      Alert.alert('Success', 'Background has been removed successfully.');
    },
    onError: (err: any) => {
      hError();
      setRemovingBg(false);
      Alert.alert('Error', err?.message || 'Failed to remove background.');
    },
  });

  // const styles = StyleSheet.create({
  //   image: {
  //     width: '100%',
  //     height: 320,
  //     borderRadius: tokens.borderRadius.md,
  //     marginBottom: 20,
  //   },
  //   input: {
  //     borderRadius: tokens.borderRadius.md,
  //     paddingHorizontal: 12,
  //     paddingVertical: 10,
  //     marginBottom: 14,
  //     fontSize: 15,
  //     color: theme.colors.foreground,
  //     backgroundColor: theme.colors.input2,
  //     borderWidth: 1,
  //     borderColor: theme.colors.inputBorder,
  //   },
  //   buttonRow: {
  //     flexDirection: 'row',
  //     justifyContent: 'space-evenly',
  //     marginTop: 10,
  //     flexWrap: 'wrap',
  //     gap: 12,
  //   },
  //   cancelButton: {
  //     backgroundColor: theme.colors.muted,
  //   },
  // });

  const styles = StyleSheet.create({
    image: {
      width: '100%',
      height: 320,
      borderRadius: tokens.borderRadius.switch1,
      marginBottom: 20,
      backgroundColor: theme.colors.imageBackground,
      padding: 4,
    },
    input: {
      borderRadius: tokens.borderRadius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 14,
      fontSize: 15,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.input2,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
    },
    buttonRow: {
      flexDirection: 'row',
      justifyContent: 'space-evenly',
      flexWrap: 'wrap',
      marginTop: moderateScale(tokens.spacing.md),
      rowGap: moderateScale(tokens.spacing.sm),
      columnGap: moderateScale(tokens.spacing.sm),
    },
    buttonHalf: {
      width: '45%',
      minWidth: 140,
      alignItems: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.muted,
    },
    deleteButton: {
      backgroundColor: 'red',
      marginTop: moderateScale(tokens.spacing.md),
      alignSelf: 'center',
      width: '60%',
      minWidth: 160,
    },
  });

  return (
    <Animated.View
      style={{
        flex: 1,
        transform: [{translateY: slideUpAnim}],
        opacity: opacityAnim,
      }}>
      <ScrollView
        style={[
          useGlobalStyles().screen,
          useGlobalStyles().section6,
          {marginBottom: 80},
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingBottom: 100}}>
        <View
          style={{
            height: insets.top + 60, // ⬅️ 56 is about the old navbar height
            backgroundColor: theme.colors.background, // same tone as old nav
          }}
        />
        <View
          style={[
            useGlobalStyles().modalSection,
            useGlobalStyles().cardStyles3,
            {paddingVertical: 20},
          ]}>
          {(item?.touchedUpImageUrl ||
            item?.processedImageUrl ||
            item?.image_url) && (
            <Image
              source={{
                uri:
                  item.touchedUpImageUrl ??
                  item.processedImageUrl ??
                  item.image_url,
              }}
              style={styles.image}
              resizeMode="contain"
            />
          )}

          {/* Core */}
          <Text style={useGlobalStyles().title}>Name</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} />

          <FieldPicker
            label="Category"
            value={category}
            options={MAIN_CATEGORIES}
            onChange={val => {
              setCategory(val);
              setSubcategory('');
            }}
            placeholder="Select category…"
          />

          {category &&
            (categoriesJson as Record<string, string[]>)[category]?.length >
              0 && (
              <FieldPicker
                label="Subcategory"
                value={subcategory}
                options={
                  (categoriesJson as Record<string, string[]>)[category] ?? []
                }
                onChange={setSubcategory}
                allowCustom
                placeholder="Select subcategory…"
              />
            )}

          <Text style={useGlobalStyles().title}>Material</Text>
          <TextInput
            value={material}
            onChangeText={setMaterial}
            style={styles.input}
            placeholder="e.g. Cotton, Wool, Linen"
            placeholderTextColor={theme.colors.muted}
          />

          <FieldPicker
            label="Fit"
            value={fit}
            options={FIT_OPTIONS}
            onChange={setFit}
            placeholder="Select fit…"
          />

          <Text style={useGlobalStyles().title}>Size</Text>
          <TextInput
            value={size}
            onChangeText={setSize}
            style={styles.input}
            placeholder="e.g. M, L, 32x32"
            placeholderTextColor={theme.colors.muted}
          />

          <Text style={useGlobalStyles().title}>Brand</Text>
          <TextInput
            value={brand}
            onChangeText={setBrand}
            style={styles.input}
            placeholder="e.g. Ferragamo"
            placeholderTextColor={theme.colors.muted}
          />

          <Text style={useGlobalStyles().title}>Color</Text>
          <TextInput
            value={color}
            onChangeText={setColor}
            style={styles.input}
            placeholder="e.g. Navy, White, Tan"
            placeholderTextColor={theme.colors.muted}
          />

          <Text style={useGlobalStyles().title}>Tags</Text>
          <TextInput
            value={tags}
            onChangeText={setTags}
            style={styles.input}
            placeholder="Comma separated: casual, spring, linen"
            placeholderTextColor={theme.colors.muted}
          />

          {/* Enriched */}
          <FieldPicker
            label="Pattern"
            value={pattern}
            options={PATTERN_OPTIONS}
            onChange={setPattern}
            placeholder="Select pattern…"
          />

          <FieldPicker
            label="Pattern Scale"
            value={patternScale}
            options={PATTERN_SCALE_OPTIONS}
            onChange={setPatternScale}
            placeholder="Select pattern scale…"
          />

          <FieldPicker
            label="Seasonality"
            value={seasonality}
            options={SEASONALITY_OPTIONS}
            onChange={setSeasonality}
            placeholder="Select season…"
          />

          <FieldPicker
            label="Layering"
            value={layering}
            options={LAYERING_OPTIONS}
            onChange={setLayering}
            placeholder="Select layer…"
          />

          {/* Derived (from AddItemScreen) */}
          <FieldPicker
            label="Dress Code"
            value={dressCode}
            options={DRESS_CODE_OPTIONS}
            onChange={setDressCode}
            placeholder="Select dress code…"
          />

          <FieldPicker
            label="Anchor Role"
            value={anchorRole}
            options={ANCHOR_ROLE_OPTIONS}
            onChange={setAnchorRole}
            placeholder="Select anchor role…"
          />

          <FieldPicker
            label="Color Family"
            value={colorFamily}
            options={COLOR_FAMILY_OPTIONS}
            onChange={setColorFamily}
            placeholder="Select color family…"
          />

          <FieldPicker
            label="Occasion Tags"
            value={occasionTags}
            options={OCCASION_OPTIONS}
            onChange={setOccasionTags}
            multiple
            placeholder="Select occasions…"
          />

          <View style={styles.buttonRow}>
            <AppleTouchFeedback
              style={[useGlobalStyles().buttonPrimary, styles.buttonHalf]}
              hapticStyle="impactMedium"
              onPress={() => updateMutation.mutate()}>
              <Text style={useGlobalStyles().buttonPrimaryText}>
                Save Changes
              </Text>
            </AppleTouchFeedback>

            <AppleTouchFeedback
              style={[
                useGlobalStyles().buttonPrimary,
                styles.cancelButton,
                styles.buttonHalf,
              ]}
              hapticStyle="impactLight"
              onPress={() => navigation.goBack()}>
              <Text style={useGlobalStyles().buttonPrimaryText}>Cancel</Text>
            </AppleTouchFeedback>
          </View>

          <View
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              marginTop: 16,
              flexDirection: 'row',
              gap: 12,
            }}>
            <AppleTouchFeedback
              style={[
                useGlobalStyles().buttonPrimary,
                {
                  backgroundColor: 'black',
                  width: 140,
                },
              ]}
              hapticStyle="impactMedium"
              onPress={() => {
                Alert.alert(
                  'Touch Up Image',
                  'This will enhance your wardrobe item by making it more presentable and cleaning the image up professionally. Proceed?',
                  [
                    {text: 'Cancel', style: 'cancel'},
                    {
                      text: 'Touch Up',
                      onPress: () => touchUpMutation.mutate(),
                    },
                  ],
                );
              }}
              disabled={touchingUp}>
              <Text style={useGlobalStyles().buttonPrimaryText}>
                {touchingUp ? 'Touching up...' : 'Touch up'}
              </Text>
            </AppleTouchFeedback>

            <AppleTouchFeedback
              style={[
                useGlobalStyles().buttonPrimary,
                {
                  backgroundColor: 'black',
                  width: 140,
                },
              ]}
              hapticStyle="impactMedium"
              onPress={() => {
                Alert.alert(
                  'Remove Background',
                  'This will remove the background from the image and replace it with a transparent background. Proceed?',
                  [
                    {text: 'Cancel', style: 'cancel'},
                    {
                      text: 'Remove BG',
                      onPress: () => removeBackgroundMutation.mutate(),
                    },
                  ],
                );
              }}
              disabled={removingBg}>
              <Text style={useGlobalStyles().buttonPrimaryText}>
                {removingBg ? 'Removing...' : 'Remove BG'}
              </Text>
            </AppleTouchFeedback>

            {/* <AppleTouchFeedback
              style={[
                useGlobalStyles().buttonPrimary,
                {
                  backgroundColor: theme.colors.primary,
                  width: 140,
                },
              ]}
              hapticStyle="impactMedium"
              onPress={() => {
                const imageUri =
                  item?.touchedUpImageUrl ??
                  item?.touched_up_image_url ??
                  item?.processedImageUrl ??
                  item?.processed_image_url ??
                  item?.image_url;
                navigation.navigate('TryOnOverlay', {
                  outfit: {
                    top: {
                      name: item?.name || 'Item',
                      imageUri: imageUri,
                    },
                  },
                });
              }}>
              <Text style={useGlobalStyles().buttonPrimaryText}>Try On</Text>
            </AppleTouchFeedback> */}
          </View>

          <View style={{justifyContent: 'center', alignItems: 'center'}}>
            <AppleTouchFeedback
              style={[
                useGlobalStyles().buttonPrimary,
                {backgroundColor: 'red', marginTop: 16, width: 150},
              ]}
              hapticStyle="impactHeavy"
              onPress={handleDelete}>
              <Text style={useGlobalStyles().buttonPrimaryText}>
                Delete Item
              </Text>
            </AppleTouchFeedback>
          </View>
        </View>
        {touchingUp && (
          <View
            style={{
              position: 'absolute',
              top: 1100,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
            }}>
            <View
              style={{
                backgroundColor: theme.colors.surface,
                padding: 24,
                borderRadius: 16,
                alignItems: 'center',
              }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 16,
                  fontWeight: '600',
                  marginBottom: 12,
                }}>
                Touching up image...
              </Text>
              <View style={{marginTop: 4}}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            </View>
          </View>
        )}
        {removingBg && (
          <View
            style={{
              position: 'absolute',
              top: 1100,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
            }}>
            <View
              style={{
                backgroundColor: theme.colors.surface,
                padding: 24,
                borderRadius: 16,
                alignItems: 'center',
              }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 16,
                  fontWeight: '600',
                  marginBottom: 12,
                }}>
                Removing background...
              </Text>
              <View style={{marginTop: 4}}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            </View>
          </View>
        )}
        {saving && (
          <View
            style={{
              position: 'absolute',
              top: 1100,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
            }}>
            <View
              style={{
                backgroundColor: theme.colors.surface,
                padding: 24,
                borderRadius: 16,
                alignItems: 'center',
              }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 16,
                  fontWeight: '600',
                  marginBottom: 12,
                }}>
                Saving your changes…
              </Text>
              <View style={{marginTop: 4}}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            </View>
          </View>
        )}
        {deleting && (
          <View
            style={{
              position: 'absolute',
              top: 1100,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
            }}>
            <View
              style={{
                backgroundColor: theme.colors.surface,
                padding: 24,
                borderRadius: 16,
                alignItems: 'center',
              }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 16,
                  fontWeight: '600',
                  marginBottom: 12,
                }}>
                Deleting item…
              </Text>
              <View style={{marginTop: 4}}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </Animated.View>
  );
}

/////////////////////////

// // apps/frontend/screens/ItemDetailScreen.tsx
// import React, {useState, useEffect, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   TextInput,
//   ScrollView,
//   Pressable,
//   Alert,
// } from 'react-native';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';
// import {mockClothingItems} from '../../components/mockClothingItems/mockClothingItems';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {ActivityIndicator} from 'react-native';

// type Props = {
//   route: any;
//   navigation: any;
// };

// // ─────────────────────────────────────────────
// // Normalizers (mirrored from AddItemScreen)
// // ─────────────────────────────────────────────
// const normalizePatternScale = (
//   raw: string,
// ): 'subtle' | 'medium' | 'bold' | undefined => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (/^-?\d+(\.\d+)?$/.test(s)) {
//     const n = Number(s);
//     return n <= 0 ? 'subtle' : n === 1 ? 'medium' : 'bold';
//   }
//   if (['subtle', 'small', 'micro'].includes(s)) return 'subtle';
//   if (['medium', 'mid'].includes(s)) return 'medium';
//   if (['bold', 'large', 'big'].includes(s)) return 'bold';
//   return undefined;
// };

// const normalizeSeasonality = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['ss', 'spring', 'summer', 'spring/summer', 's/s'].includes(s))
//     return 'SS';
//   if (['fw', 'fall', 'autumn', 'winter', 'fall/winter', 'f/w'].includes(s))
//     return 'FW';
//   if (
//     [
//       'all',
//       'allseason',
//       'all-season',
//       'all season',
//       'year-round',
//       'year round',
//       'all_season',
//     ].includes(s)
//   )
//     return 'ALL_SEASON';
//   return raw;
// };

// const normalizeLayering = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['base', 'baselayer'].includes(s)) return 'BASE';
//   if (['mid', 'midlayer'].includes(s)) return 'MID';
//   if (['shell', 'outer', 'outerwear', 'jacket'].includes(s)) return 'SHELL';
//   if (['accent', 'accessory', 'acc'].includes(s)) return 'ACCENT';
//   return raw;
// };

// export default function ItemDetailScreen({route, navigation}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const {itemId, item: routeItem} = route.params;
//   const item = useMemo(
//     () => routeItem ?? mockClothingItems.find(i => i.id === itemId),
//     [routeItem, itemId],
//   );

//   const hSuccess = () =>
//     ReactNativeHapticFeedback.trigger('notificationSuccess', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });
//   const hError = () =>
//     ReactNativeHapticFeedback.trigger('notificationError', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   // Core/base
//   const [name, setName] = useState('');
//   const [category, setCategory] = useState(''); // ↔ main_category
//   const [subcategory, setSubcategory] = useState('');
//   const [color, setColor] = useState('');
//   const [material, setMaterial] = useState('');
//   const [fit, setFit] = useState('');
//   const [size, setSize] = useState('');
//   const [brand, setBrand] = useState('');
//   const [tags, setTags] = useState(''); // comma-separated UI
//   const [saving, setSaving] = useState(false);
//   const [deleting, setDeleting] = useState(false);

//   // Enriched
//   const [pattern, setPattern] = useState('');
//   const [patternScale, setPatternScale] = useState(''); // text input; normalized on save
//   const [seasonality, setSeasonality] = useState(''); // normalized to SS/FW/ALL_SEASON
//   const [layering, setLayering] = useState(''); // normalized to BASE/MID/SHELL/ACCENT

//   // Derived fields from AddItemScreen
//   const [dressCode, setDressCode] = useState(''); // 'UltraCasual' | 'Casual' | ...
//   const [anchorRole, setAnchorRole] = useState(''); // 'Hero' | 'Neutral' | 'Connector'
//   const [colorFamily, setColorFamily] = useState(''); // e.g. Navy, Black, White
//   const [occasionTags, setOccasionTags] = useState(''); // comma UI → array: Work,DateNight,...

//   useEffect(() => {
//     if (!item) return;

//     // handle snake_case and camelCase
//     setName(item.name ?? item.ai_title ?? '');
//     setCategory(item.main_category ?? item.mainCategory ?? '');
//     setSubcategory(item.subcategory ?? item.subCategory ?? '');
//     setColor(item.color ?? '');
//     setMaterial(item.material ?? '');
//     setFit(item.fit ?? '');
//     setSize(item.size ?? item.size_label ?? '');
//     setBrand(item.brand ?? '');

//     const _tags: string[] = Array.isArray(item.tags)
//       ? item.tags
//       : typeof (item.tags as any) === 'string'
//       ? (item.tags as any)
//           .split(',')
//           .map((t: string) => t.trim())
//           .filter(Boolean)
//       : [];
//     setTags(_tags.join(', '));

//     setPattern(item.pattern ?? '');
//     // pattern_scale may be number or enum; show as text
//     const ps = item.pattern_scale;
//     setPatternScale(
//       ps === 0
//         ? '0'
//         : ps === 1
//         ? '1'
//         : ps === 2
//         ? '2'
//         : typeof ps === 'string'
//         ? ps
//         : (ps ?? '').toString(),
//     );

//     setSeasonality(item.seasonality ?? '');
//     setLayering(item.layering ?? '');

//     // derived
//     setDressCode(item.dress_code ?? '');
//     setAnchorRole(item.anchor_role ?? '');
//     setColorFamily(item.color_family ?? '');
//     const _occTags: string[] = Array.isArray(item.occasion_tags)
//       ? item.occasion_tags
//       : [];
//     setOccasionTags(_occTags.join(', '));
//   }, [item]);

//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       setSaving(true); // 🟢 start spinner
//       if (!item?.id) throw new Error('Missing item ID');

//       const normPatternScale = normalizePatternScale(patternScale || '');
//       const normSeasonality = normalizeSeasonality(seasonality || '');
//       const normLayering = normalizeLayering(layering || '');

//       const payload = {
//         name,
//         color,
//         main_category: category,
//         subcategory,
//         material,
//         fit,
//         size,
//         brand,
//         pattern,
//         pattern_scale: normPatternScale,
//         seasonality: normSeasonality,
//         layering: normLayering,
//         tags: tags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),
//         dress_code: dressCode || undefined,
//         anchor_role: anchorRole || undefined,
//         color_family: colorFamily || undefined,
//         occasion_tags: occasionTags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),
//       };

//       const res = await fetch(`${API_BASE_URL}/wardrobe/${item.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });

//       if (!res.ok) {
//         const txt = await res.text().catch(() => '');
//         throw new Error(
//           `Failed to update item ${res.status}: ${txt || res.statusText}`,
//         );
//       }
//       return res.json();
//     },
//     onSuccess: () => {
//       hSuccess();
//       setSaving(false); // 🔴 stop spinner
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: () => {
//       hError();
//       setSaving(false); // 🔴 stop spinner
//       Alert.alert('Error', 'Failed to update item.');
//     },
//   });

//   // const deleteMutation = useMutation({
//   //   mutationFn: async () => {
//   //     if (!item?.id || !item?.user_id || !item?.image_url) {
//   //       throw new Error('Missing item info');
//   //     }
//   //     const res = await fetch(`${API_BASE_URL}/wardrobe`, {
//   //       method: 'DELETE',
//   //       headers: {'Content-Type': 'application/json'},
//   //       body: JSON.stringify({
//   //         item_id: item.id,
//   //         user_id: item.user_id,
//   //         image_url: item.image_url,
//   //       }),
//   //     });
//   //     if (!res.ok) throw new Error('Failed to delete item');
//   //     return item.id;
//   //   },
//   //   onSuccess: () => {
//   //     queryClient.invalidateQueries({queryKey: ['wardrobe']});
//   //     navigation.goBack();
//   //   },
//   //   onError: () => {
//   //     Alert.alert('Error', 'Failed to delete item.');
//   //   },
//   // });

//   const deleteMutation = useMutation({
//     mutationFn: async () => {
//       setDeleting(true); // 🟢 start spinner
//       if (!item?.id || !item?.user_id || !item?.image_url) {
//         throw new Error('Missing item info');
//       }
//       const res = await fetch(`${API_BASE_URL}/wardrobe`, {
//         method: 'DELETE',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//           item_id: item.id,
//           user_id: item.user_id,
//           image_url: item.image_url,
//         }),
//       });
//       if (!res.ok) throw new Error('Failed to delete item');
//       return item.id;
//     },
//     onSuccess: () => {
//       setDeleting(false); // 🔴 stop spinner
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: () => {
//       setDeleting(false); // 🔴 stop spinner
//       Alert.alert('Error', 'Failed to delete item.');
//     },
//   });

//   const handleDelete = () => {
//     if (!item?.id) return;
//     Alert.alert('Delete Item', 'Are you sure you want to delete this item?', [
//       {text: 'Cancel', style: 'cancel'},
//       {
//         text: 'Delete',
//         style: 'destructive',
//         onPress: () => deleteMutation.mutate(),
//       },
//     ]);
//   };

//   const styles = StyleSheet.create({
//     image: {
//       width: '100%',
//       height: 320,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//     },
//     input: {
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       paddingVertical: 10,
//       marginBottom: 14,
//       fontSize: 15,
//       color: theme.colors.foreground,
//       backgroundColor: theme.colors.input2,
//       borderWidth: 1,
//       borderColor: theme.colors.inputBorder,
//     },
//     buttonRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-evenly',
//       marginTop: 10,
//       flexWrap: 'wrap',
//       gap: 12,
//     },
//     cancelButton: {
//       backgroundColor: theme.colors.muted,
//     },
//   });

//   return (
//     <ScrollView
//       style={[useGlobalStyles().screen, useGlobalStyles().section6]}
//       showsVerticalScrollIndicator={false}
//       keyboardShouldPersistTaps="handled">
//       <View
//         style={[
//           useGlobalStyles().modalSection,
//           useGlobalStyles().cardStyles3,
//           {paddingVertical: 20},
//         ]}>
//         {item?.image_url && (
//           <Image source={{uri: item.image_url}} style={styles.image} />
//         )}

//         {/* Core */}
//         <Text style={useGlobalStyles().title}>Name</Text>
//         <TextInput value={name} onChangeText={setName} style={styles.input} />

//         <Text style={useGlobalStyles().title}>Category</Text>
//         <TextInput
//           value={category}
//           onChangeText={setCategory}
//           style={styles.input}
//           placeholder="e.g. Shirt, Pants, Shoes"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Subcategory</Text>
//         <TextInput
//           value={subcategory}
//           onChangeText={setSubcategory}
//           style={styles.input}
//           placeholder="e.g. Dress Shirt, Chinos"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Material</Text>
//         <TextInput
//           value={material}
//           onChangeText={setMaterial}
//           style={styles.input}
//           placeholder="e.g. Cotton, Wool, Linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Fit</Text>
//         <TextInput
//           value={fit}
//           onChangeText={setFit}
//           style={styles.input}
//           placeholder="e.g. Slim, Regular"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Size</Text>
//         <TextInput
//           value={size}
//           onChangeText={setSize}
//           style={styles.input}
//           placeholder="e.g. M, L, 32x32"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Brand</Text>
//         <TextInput
//           value={brand}
//           onChangeText={setBrand}
//           style={styles.input}
//           placeholder="e.g. Ferragamo"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color</Text>
//         <TextInput
//           value={color}
//           onChangeText={setColor}
//           style={styles.input}
//           placeholder="e.g. Navy, White, Tan"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Tags</Text>
//         <TextInput
//           value={tags}
//           onChangeText={setTags}
//           style={styles.input}
//           placeholder="Comma separated: casual, spring, linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Enriched */}
//         <Text style={useGlobalStyles().title}>Pattern</Text>
//         <TextInput
//           value={pattern}
//           onChangeText={setPattern}
//           style={styles.input}
//           placeholder="e.g. Striped, Plaid"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Pattern Scale</Text>
//         <TextInput
//           value={patternScale}
//           onChangeText={setPatternScale}
//           style={styles.input}
//           placeholder="subtle / medium / bold or 0 / 1 / 2"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Seasonality</Text>
//         <TextInput
//           value={seasonality}
//           onChangeText={setSeasonality}
//           style={styles.input}
//           placeholder="SS, FW, or ALL_SEASON"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Layering</Text>
//         <TextInput
//           value={layering}
//           onChangeText={setLayering}
//           style={styles.input}
//           placeholder="BASE, MID, SHELL, ACCENT"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Derived (from AddItemScreen) */}
//         <Text style={useGlobalStyles().title}>Dress Code</Text>
//         <TextInput
//           value={dressCode}
//           onChangeText={setDressCode}
//           style={styles.input}
//           placeholder="UltraCasual, Casual, SmartCasual, BusinessCasual, Business, BlackTie"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Anchor Role</Text>
//         <TextInput
//           value={anchorRole}
//           onChangeText={setAnchorRole}
//           style={styles.input}
//           placeholder="Hero, Neutral, Connector"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color Family</Text>
//         <TextInput
//           value={colorFamily}
//           onChangeText={setColorFamily}
//           style={styles.input}
//           placeholder="e.g. Navy, Black, White, Gray, Beige…"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Occasion Tags</Text>
//         <TextInput
//           value={occasionTags}
//           onChangeText={setOccasionTags}
//           style={styles.input}
//           placeholder="Comma separated: Work, DateNight, Travel, Gym"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <View style={styles.buttonRow}>
//           <AppleTouchFeedback
//             style={[useGlobalStyles().buttonPrimary, {width: 150}]}
//             hapticStyle="impactMedium"
//             onPress={() => updateMutation.mutate()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>
//               Save Changes
//             </Text>
//           </AppleTouchFeedback>

//           <AppleTouchFeedback
//             style={[
//               useGlobalStyles().buttonPrimary,
//               styles.cancelButton,
//               {width: 150},
//             ]}
//             hapticStyle="impactLight"
//             onPress={() => navigation.goBack()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Cancel</Text>
//           </AppleTouchFeedback>
//         </View>

//         <View style={{justifyContent: 'center', alignItems: 'center'}}>
//           <AppleTouchFeedback
//             style={[
//               useGlobalStyles().buttonPrimary,
//               {backgroundColor: 'red', marginTop: 16, width: 150},
//             ]}
//             hapticStyle="impactHeavy"
//             onPress={handleDelete}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Delete Item</Text>
//           </AppleTouchFeedback>
//         </View>
//       </View>
//       {saving && (
//         <View
//           style={{
//             position: 'absolute',
//             top: 1100,
//             left: 0,
//             right: 0,
//             bottom: 0,
//             backgroundColor: 'rgba(0,0,0,0.45)',
//             alignItems: 'center',
//             justifyContent: 'center',
//             zIndex: 9999,
//           }}>
//           <View
//             style={{
//               backgroundColor: theme.colors.surface,
//               padding: 24,
//               borderRadius: 16,
//               alignItems: 'center',
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: 16,
//                 fontWeight: '600',
//                 marginBottom: 12,
//               }}>
//               Saving your changes…
//             </Text>
//             <View style={{marginTop: 4}}>
//               <ActivityIndicator size="large" color={theme.colors.primary} />
//             </View>
//           </View>
//         </View>
//       )}
//       {deleting && (
//         <View
//           style={{
//             position: 'absolute',
//             top: 1100,
//             left: 0,
//             right: 0,
//             bottom: 0,
//             backgroundColor: 'rgba(0,0,0,0.45)',
//             alignItems: 'center',
//             justifyContent: 'center',
//             zIndex: 9999,
//           }}>
//           <View
//             style={{
//               backgroundColor: theme.colors.surface,
//               padding: 24,
//               borderRadius: 16,
//               alignItems: 'center',
//             }}>
//             <Text
//               style={{
//                 color: theme.colors.foreground,
//                 fontSize: 16,
//                 fontWeight: '600',
//                 marginBottom: 12,
//               }}>
//               Deleting item…
//             </Text>
//             <View style={{marginTop: 4}}>
//               <ActivityIndicator size="large" color={theme.colors.primary} />
//             </View>
//           </View>
//         </View>
//       )}
//     </ScrollView>
//   );
// }

//////////////////

// // apps/frontend/screens/ItemDetailScreen.tsx
// import React, {useState, useEffect, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   TextInput,
//   ScrollView,
//   Pressable,
//   Alert,
// } from 'react-native';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';
// import {mockClothingItems} from '../../components/mockClothingItems/mockClothingItems';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';
// import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type Props = {
//   route: any;
//   navigation: any;
// };

// // ─────────────────────────────────────────────
// // Normalizers (mirrored from AddItemScreen)
// // ─────────────────────────────────────────────
// const normalizePatternScale = (
//   raw: string,
// ): 'subtle' | 'medium' | 'bold' | undefined => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (/^-?\d+(\.\d+)?$/.test(s)) {
//     const n = Number(s);
//     return n <= 0 ? 'subtle' : n === 1 ? 'medium' : 'bold';
//   }
//   if (['subtle', 'small', 'micro'].includes(s)) return 'subtle';
//   if (['medium', 'mid'].includes(s)) return 'medium';
//   if (['bold', 'large', 'big'].includes(s)) return 'bold';
//   return undefined;
// };

// const normalizeSeasonality = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['ss', 'spring', 'summer', 'spring/summer', 's/s'].includes(s))
//     return 'SS';
//   if (['fw', 'fall', 'autumn', 'winter', 'fall/winter', 'f/w'].includes(s))
//     return 'FW';
//   if (
//     [
//       'all',
//       'allseason',
//       'all-season',
//       'all season',
//       'year-round',
//       'year round',
//       'all_season',
//     ].includes(s)
//   )
//     return 'ALL_SEASON';
//   return raw;
// };

// const normalizeLayering = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['base', 'baselayer'].includes(s)) return 'BASE';
//   if (['mid', 'midlayer'].includes(s)) return 'MID';
//   if (['shell', 'outer', 'outerwear', 'jacket'].includes(s)) return 'SHELL';
//   if (['accent', 'accessory', 'acc'].includes(s)) return 'ACCENT';
//   return raw;
// };

// export default function ItemDetailScreen({route, navigation}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const {itemId, item: routeItem} = route.params;
//   const item = useMemo(
//     () => routeItem ?? mockClothingItems.find(i => i.id === itemId),
//     [routeItem, itemId],
//   );

//   const hSuccess = () =>
//     ReactNativeHapticFeedback.trigger('notificationSuccess', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });
//   const hError = () =>
//     ReactNativeHapticFeedback.trigger('notificationError', {
//       enableVibrateFallback: true,
//       ignoreAndroidSystemSettings: false,
//     });

//   // Core/base
//   const [name, setName] = useState('');
//   const [category, setCategory] = useState(''); // ↔ main_category
//   const [subcategory, setSubcategory] = useState('');
//   const [color, setColor] = useState('');
//   const [material, setMaterial] = useState('');
//   const [fit, setFit] = useState('');
//   const [size, setSize] = useState('');
//   const [brand, setBrand] = useState('');
//   const [tags, setTags] = useState(''); // comma-separated UI

//   // Enriched
//   const [pattern, setPattern] = useState('');
//   const [patternScale, setPatternScale] = useState(''); // text input; normalized on save
//   const [seasonality, setSeasonality] = useState(''); // normalized to SS/FW/ALL_SEASON
//   const [layering, setLayering] = useState(''); // normalized to BASE/MID/SHELL/ACCENT

//   // Derived fields from AddItemScreen
//   const [dressCode, setDressCode] = useState(''); // 'UltraCasual' | 'Casual' | ...
//   const [anchorRole, setAnchorRole] = useState(''); // 'Hero' | 'Neutral' | 'Connector'
//   const [colorFamily, setColorFamily] = useState(''); // e.g. Navy, Black, White
//   const [occasionTags, setOccasionTags] = useState(''); // comma UI → array: Work,DateNight,...

//   useEffect(() => {
//     if (!item) return;

//     // handle snake_case and camelCase
//     setName(item.name ?? item.ai_title ?? '');
//     setCategory(item.main_category ?? item.mainCategory ?? '');
//     setSubcategory(item.subcategory ?? item.subCategory ?? '');
//     setColor(item.color ?? '');
//     setMaterial(item.material ?? '');
//     setFit(item.fit ?? '');
//     setSize(item.size ?? item.size_label ?? '');
//     setBrand(item.brand ?? '');

//     const _tags: string[] = Array.isArray(item.tags)
//       ? item.tags
//       : typeof (item.tags as any) === 'string'
//       ? (item.tags as any)
//           .split(',')
//           .map((t: string) => t.trim())
//           .filter(Boolean)
//       : [];
//     setTags(_tags.join(', '));

//     setPattern(item.pattern ?? '');
//     // pattern_scale may be number or enum; show as text
//     const ps = item.pattern_scale;
//     setPatternScale(
//       ps === 0
//         ? '0'
//         : ps === 1
//         ? '1'
//         : ps === 2
//         ? '2'
//         : typeof ps === 'string'
//         ? ps
//         : (ps ?? '').toString(),
//     );

//     setSeasonality(item.seasonality ?? '');
//     setLayering(item.layering ?? '');

//     // derived
//     setDressCode(item.dress_code ?? '');
//     setAnchorRole(item.anchor_role ?? '');
//     setColorFamily(item.color_family ?? '');
//     const _occTags: string[] = Array.isArray(item.occasion_tags)
//       ? item.occasion_tags
//       : [];
//     setOccasionTags(_occTags.join(', '));
//   }, [item]);

//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       if (!item?.id) throw new Error('Missing item ID');

//       // normalize fields to backend DTO expectations
//       const normPatternScale = normalizePatternScale(patternScale || '');
//       const normSeasonality = normalizeSeasonality(seasonality || '');
//       const normLayering = normalizeLayering(layering || '');

//       const payload = {
//         name,
//         color,
//         main_category: category,
//         subcategory,
//         material,
//         fit,
//         size,
//         brand,
//         pattern,
//         pattern_scale: normPatternScale, // union: 'subtle'|'medium'|'bold'|undefined
//         seasonality: normSeasonality, // 'SS'|'FW'|'ALL_SEASON'|undefined
//         layering: normLayering, // 'BASE'|'MID'|'SHELL'|'ACCENT'|undefined
//         tags: tags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),

//         // derived fields (editable)
//         dress_code: dressCode || undefined,
//         anchor_role: anchorRole || undefined,
//         color_family: colorFamily || undefined,
//         occasion_tags: occasionTags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),
//       };

//       const res = await fetch(`${API_BASE_URL}/wardrobe/${item.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });
//       if (!res.ok) {
//         const txt = await res.text().catch(() => '');
//         throw new Error(
//           `Failed to update item ${res.status}: ${txt || res.statusText}`,
//         );
//       }
//       return res.json();
//     },
//     onSuccess: () => {
//       hSuccess();
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: () => {
//       hError();
//       Alert.alert('Error', 'Failed to delete item.');
//     },
//   });

//   const deleteMutation = useMutation({
//     mutationFn: async () => {
//       if (!item?.id || !item?.user_id || !item?.image_url) {
//         throw new Error('Missing item info');
//       }
//       const res = await fetch(`${API_BASE_URL}/wardrobe`, {
//         method: 'DELETE',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//           item_id: item.id,
//           user_id: item.user_id,
//           image_url: item.image_url,
//         }),
//       });
//       if (!res.ok) throw new Error('Failed to delete item');
//       return item.id;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: () => {
//       Alert.alert('Error', 'Failed to delete item.');
//     },
//   });

//   const handleDelete = () => {
//     if (!item?.id) return;
//     Alert.alert('Delete Item', 'Are you sure you want to delete this item?', [
//       {text: 'Cancel', style: 'cancel'},
//       {
//         text: 'Delete',
//         style: 'destructive',
//         onPress: () => deleteMutation.mutate(),
//       },
//     ]);
//   };

//   const styles = StyleSheet.create({
//     image: {
//       width: '100%',
//       height: 320,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//     },
//     input: {
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       paddingVertical: 10,
//       marginBottom: 14,
//       fontSize: 15,
//       color: theme.colors.foreground,
//       backgroundColor: theme.colors.input2,
//       borderWidth: 1,
//       borderColor: theme.colors.inputBorder,
//     },
//     buttonRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-evenly',
//       marginTop: 10,
//       flexWrap: 'wrap',
//       gap: 12,
//     },
//     cancelButton: {
//       backgroundColor: theme.colors.muted,
//     },
//   });

//   return (
//     <ScrollView
//       style={[useGlobalStyles().screen, useGlobalStyles().section6]}
//       showsVerticalScrollIndicator={false}
//       keyboardShouldPersistTaps="handled">
//       <View
//         style={[
//           useGlobalStyles().modalSection,
//           useGlobalStyles().cardStyles3,
//           {paddingVertical: 20},
//         ]}>
//         {item?.image_url && (
//           <Image source={{uri: item.image_url}} style={styles.image} />
//         )}

//         {/* Core */}
//         <Text style={useGlobalStyles().title}>Name</Text>
//         <TextInput value={name} onChangeText={setName} style={styles.input} />

//         <Text style={useGlobalStyles().title}>Category</Text>
//         <TextInput
//           value={category}
//           onChangeText={setCategory}
//           style={styles.input}
//           placeholder="e.g. Shirt, Pants, Shoes"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Subcategory</Text>
//         <TextInput
//           value={subcategory}
//           onChangeText={setSubcategory}
//           style={styles.input}
//           placeholder="e.g. Dress Shirt, Chinos"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Material</Text>
//         <TextInput
//           value={material}
//           onChangeText={setMaterial}
//           style={styles.input}
//           placeholder="e.g. Cotton, Wool, Linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Fit</Text>
//         <TextInput
//           value={fit}
//           onChangeText={setFit}
//           style={styles.input}
//           placeholder="e.g. Slim, Regular"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Size</Text>
//         <TextInput
//           value={size}
//           onChangeText={setSize}
//           style={styles.input}
//           placeholder="e.g. M, L, 32x32"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Brand</Text>
//         <TextInput
//           value={brand}
//           onChangeText={setBrand}
//           style={styles.input}
//           placeholder="e.g. Ferragamo"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color</Text>
//         <TextInput
//           value={color}
//           onChangeText={setColor}
//           style={styles.input}
//           placeholder="e.g. Navy, White, Tan"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Tags</Text>
//         <TextInput
//           value={tags}
//           onChangeText={setTags}
//           style={styles.input}
//           placeholder="Comma separated: casual, spring, linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Enriched */}
//         <Text style={useGlobalStyles().title}>Pattern</Text>
//         <TextInput
//           value={pattern}
//           onChangeText={setPattern}
//           style={styles.input}
//           placeholder="e.g. Striped, Plaid"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Pattern Scale</Text>
//         <TextInput
//           value={patternScale}
//           onChangeText={setPatternScale}
//           style={styles.input}
//           placeholder="subtle / medium / bold or 0 / 1 / 2"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Seasonality</Text>
//         <TextInput
//           value={seasonality}
//           onChangeText={setSeasonality}
//           style={styles.input}
//           placeholder="SS, FW, or ALL_SEASON"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Layering</Text>
//         <TextInput
//           value={layering}
//           onChangeText={setLayering}
//           style={styles.input}
//           placeholder="BASE, MID, SHELL, ACCENT"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Derived (from AddItemScreen) */}
//         <Text style={useGlobalStyles().title}>Dress Code</Text>
//         <TextInput
//           value={dressCode}
//           onChangeText={setDressCode}
//           style={styles.input}
//           placeholder="UltraCasual, Casual, SmartCasual, BusinessCasual, Business, BlackTie"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Anchor Role</Text>
//         <TextInput
//           value={anchorRole}
//           onChangeText={setAnchorRole}
//           style={styles.input}
//           placeholder="Hero, Neutral, Connector"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color Family</Text>
//         <TextInput
//           value={colorFamily}
//           onChangeText={setColorFamily}
//           style={styles.input}
//           placeholder="e.g. Navy, Black, White, Gray, Beige…"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Occasion Tags</Text>
//         <TextInput
//           value={occasionTags}
//           onChangeText={setOccasionTags}
//           style={styles.input}
//           placeholder="Comma separated: Work, DateNight, Travel, Gym"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <View style={styles.buttonRow}>
//           <AppleTouchFeedback
//             style={[useGlobalStyles().buttonPrimary, {width: 150}]}
//             hapticStyle="impactMedium"
//             onPress={() => updateMutation.mutate()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>
//               Save Changes
//             </Text>
//           </AppleTouchFeedback>

//           <AppleTouchFeedback
//             style={[
//               useGlobalStyles().buttonPrimary,
//               styles.cancelButton,
//               {width: 150},
//             ]}
//             hapticStyle="impactLight"
//             onPress={() => navigation.goBack()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Cancel</Text>
//           </AppleTouchFeedback>
//         </View>

//         <View style={{justifyContent: 'center', alignItems: 'center'}}>
//           <AppleTouchFeedback
//             style={[
//               useGlobalStyles().buttonPrimary,
//               {backgroundColor: 'red', marginTop: 16, width: 150},
//             ]}
//             hapticStyle="impactHeavy"
//             onPress={handleDelete}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Delete Item</Text>
//           </AppleTouchFeedback>
//         </View>
//       </View>
//     </ScrollView>
//   );
// }

///////////////////////

// // apps/frontend/screens/ItemDetailScreen.tsx
// import React, {useState, useEffect, useMemo} from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   Image,
//   TextInput,
//   ScrollView,
//   Pressable,
//   Alert,
// } from 'react-native';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useMutation, useQueryClient} from '@tanstack/react-query';
// import {API_BASE_URL} from '../../config/api';
// import {mockClothingItems} from '../../components/mockClothingItems/mockClothingItems';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import {tokens} from '../../styles/tokens/tokens';

// type Props = {
//   route: any;
//   navigation: any;
// };

// // ─────────────────────────────────────────────
// // Normalizers (mirrored from AddItemScreen)
// // ─────────────────────────────────────────────
// const normalizePatternScale = (
//   raw: string,
// ): 'subtle' | 'medium' | 'bold' | undefined => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (/^-?\d+(\.\d+)?$/.test(s)) {
//     const n = Number(s);
//     return n <= 0 ? 'subtle' : n === 1 ? 'medium' : 'bold';
//   }
//   if (['subtle', 'small', 'micro'].includes(s)) return 'subtle';
//   if (['medium', 'mid'].includes(s)) return 'medium';
//   if (['bold', 'large', 'big'].includes(s)) return 'bold';
//   return undefined;
// };

// const normalizeSeasonality = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['ss', 'spring', 'summer', 'spring/summer', 's/s'].includes(s))
//     return 'SS';
//   if (['fw', 'fall', 'autumn', 'winter', 'fall/winter', 'f/w'].includes(s))
//     return 'FW';
//   if (
//     [
//       'all',
//       'allseason',
//       'all-season',
//       'all season',
//       'year-round',
//       'year round',
//       'all_season',
//     ].includes(s)
//   )
//     return 'ALL_SEASON';
//   return raw;
// };

// const normalizeLayering = (raw: string) => {
//   if (!raw) return undefined;
//   const s = raw.trim().toLowerCase();
//   if (['base', 'baselayer'].includes(s)) return 'BASE';
//   if (['mid', 'midlayer'].includes(s)) return 'MID';
//   if (['shell', 'outer', 'outerwear', 'jacket'].includes(s)) return 'SHELL';
//   if (['accent', 'accessory', 'acc'].includes(s)) return 'ACCENT';
//   return raw;
// };

// export default function ItemDetailScreen({route, navigation}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const queryClient = useQueryClient();

//   const {itemId, item: routeItem} = route.params;
//   const item = useMemo(
//     () => routeItem ?? mockClothingItems.find(i => i.id === itemId),
//     [routeItem, itemId],
//   );

//   // Core/base
//   const [name, setName] = useState('');
//   const [category, setCategory] = useState(''); // ↔ main_category
//   const [subcategory, setSubcategory] = useState('');
//   const [color, setColor] = useState('');
//   const [material, setMaterial] = useState('');
//   const [fit, setFit] = useState('');
//   const [size, setSize] = useState('');
//   const [brand, setBrand] = useState('');
//   const [tags, setTags] = useState(''); // comma-separated UI

//   // Enriched
//   const [pattern, setPattern] = useState('');
//   const [patternScale, setPatternScale] = useState(''); // text input; normalized on save
//   const [seasonality, setSeasonality] = useState(''); // normalized to SS/FW/ALL_SEASON
//   const [layering, setLayering] = useState(''); // normalized to BASE/MID/SHELL/ACCENT

//   // Derived fields from AddItemScreen
//   const [dressCode, setDressCode] = useState(''); // 'UltraCasual' | 'Casual' | ...
//   const [anchorRole, setAnchorRole] = useState(''); // 'Hero' | 'Neutral' | 'Connector'
//   const [colorFamily, setColorFamily] = useState(''); // e.g. Navy, Black, White
//   const [occasionTags, setOccasionTags] = useState(''); // comma UI → array: Work,DateNight,...

//   useEffect(() => {
//     if (!item) return;

//     // handle snake_case and camelCase
//     setName(item.name ?? item.ai_title ?? '');
//     setCategory(item.main_category ?? item.mainCategory ?? '');
//     setSubcategory(item.subcategory ?? item.subCategory ?? '');
//     setColor(item.color ?? '');
//     setMaterial(item.material ?? '');
//     setFit(item.fit ?? '');
//     setSize(item.size ?? item.size_label ?? '');
//     setBrand(item.brand ?? '');

//     const _tags: string[] = Array.isArray(item.tags)
//       ? item.tags
//       : typeof (item.tags as any) === 'string'
//       ? (item.tags as any)
//           .split(',')
//           .map((t: string) => t.trim())
//           .filter(Boolean)
//       : [];
//     setTags(_tags.join(', '));

//     setPattern(item.pattern ?? '');
//     // pattern_scale may be number or enum; show as text
//     const ps = item.pattern_scale;
//     setPatternScale(
//       ps === 0
//         ? '0'
//         : ps === 1
//         ? '1'
//         : ps === 2
//         ? '2'
//         : typeof ps === 'string'
//         ? ps
//         : (ps ?? '').toString(),
//     );

//     setSeasonality(item.seasonality ?? '');
//     setLayering(item.layering ?? '');

//     // derived
//     setDressCode(item.dress_code ?? '');
//     setAnchorRole(item.anchor_role ?? '');
//     setColorFamily(item.color_family ?? '');
//     const _occTags: string[] = Array.isArray(item.occasion_tags)
//       ? item.occasion_tags
//       : [];
//     setOccasionTags(_occTags.join(', '));
//   }, [item]);

//   const updateMutation = useMutation({
//     mutationFn: async () => {
//       if (!item?.id) throw new Error('Missing item ID');

//       // normalize fields to backend DTO expectations
//       const normPatternScale = normalizePatternScale(patternScale || '');
//       const normSeasonality = normalizeSeasonality(seasonality || '');
//       const normLayering = normalizeLayering(layering || '');

//       const payload = {
//         name,
//         color,
//         main_category: category,
//         subcategory,
//         material,
//         fit,
//         size,
//         brand,
//         pattern,
//         pattern_scale: normPatternScale, // union: 'subtle'|'medium'|'bold'|undefined
//         seasonality: normSeasonality, // 'SS'|'FW'|'ALL_SEASON'|undefined
//         layering: normLayering, // 'BASE'|'MID'|'SHELL'|'ACCENT'|undefined
//         tags: tags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),

//         // derived fields (editable)
//         dress_code: dressCode || undefined,
//         anchor_role: anchorRole || undefined,
//         color_family: colorFamily || undefined,
//         occasion_tags: occasionTags
//           .split(',')
//           .map(t => t.trim())
//           .filter(Boolean),
//       };

//       const res = await fetch(`${API_BASE_URL}/wardrobe/${item.id}`, {
//         method: 'PUT',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify(payload),
//       });
//       if (!res.ok) {
//         const txt = await res.text().catch(() => '');
//         throw new Error(
//           `Failed to update item ${res.status}: ${txt || res.statusText}`,
//         );
//       }
//       return res.json();
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: (e: any) => {
//       Alert.alert('Error', e?.message || 'Failed to save changes.');
//     },
//   });

//   const deleteMutation = useMutation({
//     mutationFn: async () => {
//       if (!item?.id || !item?.user_id || !item?.image_url) {
//         throw new Error('Missing item info');
//       }
//       const res = await fetch(`${API_BASE_URL}/wardrobe`, {
//         method: 'DELETE',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//           item_id: item.id,
//           user_id: item.user_id,
//           image_url: item.image_url,
//         }),
//       });
//       if (!res.ok) throw new Error('Failed to delete item');
//       return item.id;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({queryKey: ['wardrobe']});
//       navigation.goBack();
//     },
//     onError: () => {
//       Alert.alert('Error', 'Failed to delete item.');
//     },
//   });

//   const handleDelete = () => {
//     if (!item?.id) return;
//     Alert.alert('Delete Item', 'Are you sure you want to delete this item?', [
//       {text: 'Cancel', style: 'cancel'},
//       {
//         text: 'Delete',
//         style: 'destructive',
//         onPress: () => deleteMutation.mutate(),
//       },
//     ]);
//   };

//   const styles = StyleSheet.create({
//     image: {
//       width: '100%',
//       height: 320,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//     },
//     input: {
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       paddingVertical: 10,
//       marginBottom: 14,
//       fontSize: 15,
//       color: theme.colors.foreground,
//       backgroundColor: theme.colors.input2,
//       borderWidth: 1,
//       borderColor: theme.colors.inputBorder,
//     },
//     buttonRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-evenly',
//       marginTop: 10,
//       flexWrap: 'wrap',
//       gap: 12,
//     },
//     cancelButton: {
//       backgroundColor: theme.colors.muted,
//     },
//   });

//   return (
//     <ScrollView
//       style={[useGlobalStyles().screen, useGlobalStyles().section]}
//       showsVerticalScrollIndicator={false}
//       keyboardShouldPersistTaps="handled">
//       <View
//         style={[
//           useGlobalStyles().modalSection,
//           useGlobalStyles().cardStyles3,
//           {paddingVertical: 20},
//         ]}>
//         {item?.image_url && (
//           <Image source={{uri: item.image_url}} style={styles.image} />
//         )}

//         {/* Core */}
//         <Text style={useGlobalStyles().title}>Name</Text>
//         <TextInput value={name} onChangeText={setName} style={styles.input} />

//         <Text style={useGlobalStyles().title}>Category</Text>
//         <TextInput
//           value={category}
//           onChangeText={setCategory}
//           style={styles.input}
//           placeholder="e.g. Shirt, Pants, Shoes"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Subcategory</Text>
//         <TextInput
//           value={subcategory}
//           onChangeText={setSubcategory}
//           style={styles.input}
//           placeholder="e.g. Dress Shirt, Chinos"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Material</Text>
//         <TextInput
//           value={material}
//           onChangeText={setMaterial}
//           style={styles.input}
//           placeholder="e.g. Cotton, Wool, Linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Fit</Text>
//         <TextInput
//           value={fit}
//           onChangeText={setFit}
//           style={styles.input}
//           placeholder="e.g. Slim, Regular"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Size</Text>
//         <TextInput
//           value={size}
//           onChangeText={setSize}
//           style={styles.input}
//           placeholder="e.g. M, L, 32x32"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Brand</Text>
//         <TextInput
//           value={brand}
//           onChangeText={setBrand}
//           style={styles.input}
//           placeholder="e.g. Ferragamo"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color</Text>
//         <TextInput
//           value={color}
//           onChangeText={setColor}
//           style={styles.input}
//           placeholder="e.g. Navy, White, Tan"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Tags</Text>
//         <TextInput
//           value={tags}
//           onChangeText={setTags}
//           style={styles.input}
//           placeholder="Comma separated: casual, spring, linen"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Enriched */}
//         <Text style={useGlobalStyles().title}>Pattern</Text>
//         <TextInput
//           value={pattern}
//           onChangeText={setPattern}
//           style={styles.input}
//           placeholder="e.g. Striped, Plaid"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Pattern Scale</Text>
//         <TextInput
//           value={patternScale}
//           onChangeText={setPatternScale}
//           style={styles.input}
//           placeholder="subtle / medium / bold or 0 / 1 / 2"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Seasonality</Text>
//         <TextInput
//           value={seasonality}
//           onChangeText={setSeasonality}
//           style={styles.input}
//           placeholder="SS, FW, or ALL_SEASON"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Layering</Text>
//         <TextInput
//           value={layering}
//           onChangeText={setLayering}
//           style={styles.input}
//           placeholder="BASE, MID, SHELL, ACCENT"
//           placeholderTextColor={theme.colors.muted}
//         />

//         {/* Derived (from AddItemScreen) */}
//         <Text style={useGlobalStyles().title}>Dress Code</Text>
//         <TextInput
//           value={dressCode}
//           onChangeText={setDressCode}
//           style={styles.input}
//           placeholder="UltraCasual, Casual, SmartCasual, BusinessCasual, Business, BlackTie"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Anchor Role</Text>
//         <TextInput
//           value={anchorRole}
//           onChangeText={setAnchorRole}
//           style={styles.input}
//           placeholder="Hero, Neutral, Connector"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Color Family</Text>
//         <TextInput
//           value={colorFamily}
//           onChangeText={setColorFamily}
//           style={styles.input}
//           placeholder="e.g. Navy, Black, White, Gray, Beige…"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <Text style={useGlobalStyles().title}>Occasion Tags</Text>
//         <TextInput
//           value={occasionTags}
//           onChangeText={setOccasionTags}
//           style={styles.input}
//           placeholder="Comma separated: Work, DateNight, Travel, Gym"
//           placeholderTextColor={theme.colors.muted}
//         />

//         <View style={styles.buttonRow}>
//           <Pressable
//             style={[useGlobalStyles().buttonPrimary, {width: 150}]}
//             onPress={() => updateMutation.mutate()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>
//               Save Changes
//             </Text>
//           </Pressable>
//           <Pressable
//             style={[
//               useGlobalStyles().buttonPrimary,
//               styles.cancelButton,
//               ,
//               {width: 150},
//             ]}
//             onPress={() => navigation.goBack()}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Cancel</Text>
//           </Pressable>
//         </View>

//         <View style={{justifyContent: 'center', alignItems: 'center'}}>
//           <Pressable
//             style={[
//               useGlobalStyles().buttonPrimary,
//               {backgroundColor: 'red', marginTop: 16, width: 150},
//             ]}
//             onPress={handleDelete}>
//             <Text style={useGlobalStyles().buttonPrimaryText}>Delete Item</Text>
//           </Pressable>
//         </View>
//       </View>
//     </ScrollView>
//   );
// }
