import React, {useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  SectionList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {useAppTheme} from '../context/ThemeContext';
import {useUUID} from '../context/UUIDContext';
import {useStyleProfile} from '../hooks/useStyleProfile';
import {tokens} from '../styles/tokens/tokens';
import brandsData from '../data/brands.json';

const VOCAB_KEY = 'preferred_brands_vocab';

const h = (type: string) =>
  ReactNativeHapticFeedback.trigger(type, {
    enableVibrateFallback: true,
    ignoreAndroidSystemSettings: false,
  });

type Brand = {id: string; name: string};

type Props = {
  navigate: (screen: string, params?: any) => void;
  goBack: () => void;
  params?: {selected?: string[]};
};

function getBucket(name: string): string {
  const first = name.charAt(0);
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : '#';
}

function buildSections(brands: Brand[]) {
  const map = new Map<string, Brand[]>();
  for (const b of brands) {
    const bucket = getBucket(b.name);
    if (!map.has(bucket)) map.set(bucket, []);
    map.get(bucket)!.push(b);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === '#') return -1;
    if (b === '#') return 1;
    return a.localeCompare(b);
  });
  return keys.map(k => ({title: k, data: map.get(k)!}));
}

export default function AllBrandsPickerScreen({goBack, params}: Props) {
  const {theme} = useAppTheme();
  const colors = theme.colors;
  const insets = useSafeAreaInsets();
  const uuid = useUUID();
  const {updateProfileAsync} = useStyleProfile(uuid || '');

  const initialSelected = params?.selected ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const name of initialSelected) {
      set.add(name.toLowerCase());
    }
    return set;
  });
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedCount = selected.size;

  const filteredBrands = useMemo(() => {
    if (!search.trim()) return brandsData as Brand[];
    const q = search.toLowerCase();
    return (brandsData as Brand[]).filter(b =>
      b.name.toLowerCase().includes(q),
    );
  }, [search]);

  const sections = useMemo(() => buildSections(filteredBrands), [filteredBrands]);

  const isSelected = (name: string) => selected.has(name.toLowerCase());

  const toggle = (name: string) => {
    h('impactLight');
    setSelected(prev => {
      const next = new Set(prev);
      const key = name.toLowerCase();
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleDone = async () => {
    if (saving) return;
    setSaving(true);

    // Build final brand list: use display name from master list when selected,
    // preserve original casing for brands that came from DB but aren't in master list
    const masterMap = new Map<string, string>();
    for (const b of brandsData as Brand[]) {
      masterMap.set(b.name.toLowerCase(), b.name);
    }

    const finalBrands: string[] = [];
    const seen = new Set<string>();

    for (const key of selected) {
      if (seen.has(key)) continue;
      seen.add(key);
      // Prefer the original DB casing if it existed, else use master display name
      const dbMatch = initialSelected.find(s => s.toLowerCase() === key);
      const masterMatch = masterMap.get(key);
      finalBrands.push(dbMatch ?? masterMatch ?? key);
    }

    try {
      await updateProfileAsync('preferred_brands', finalBrands);
      // Update AsyncStorage vocab so BudgetAndBrandsScreen picks it up on remount
      const stored = await AsyncStorage.getItem(VOCAB_KEY);
      const vocab: string[] = stored ? JSON.parse(stored) : [];
      const vocabSet = new Set(vocab.map(v => v.toLowerCase()));
      for (const b of finalBrands) {
        if (!vocabSet.has(b.toLowerCase())) {
          vocab.push(b);
        }
      }
      await AsyncStorage.setItem(VOCAB_KEY, JSON.stringify(vocab));
      goBack();
    } catch {
      h('notificationError');
      setSaving(false);
    }
  };

  const styles = StyleSheet.create({
    container: {flex: 1, backgroundColor: colors.background},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    headerLeft: {flexDirection: 'row', alignItems: 'center'},
    headerTitle: {fontSize: 17, fontWeight: '600', color: colors.foreground},
    doneBtn: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.primary,
    },
    doneBtnDisabled: {opacity: 0.5},
    doneBtnText: {color: colors.background, fontWeight: '600', fontSize: 15},
    searchContainer: {paddingHorizontal: 16, paddingBottom: 8},
    searchInput: {
      borderWidth: tokens.borderWidth.hairline,
      borderRadius: 10,
      borderColor: colors.inputBorder,
      backgroundColor: colors.input2,
      color: colors.foreground,
      padding: 10,
      fontSize: 16,
    },
    sectionHeader: {
      backgroundColor: colors.background,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    sectionHeaderText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.muted,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    rowText: {fontSize: 16, color: colors.foreground},
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.inputBorder,
      marginLeft: 16,
    },
  });

  return (
    <View style={styles.container}>
      {/* Spacer for GlobalHeader overlap */}
      <View style={{height: insets.top + 60, backgroundColor: colors.background}} />
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.headerLeft}>
          <Icon name="arrow-back" size={24} color={colors.button3} />
          <Text style={{color: colors.button3, fontSize: 16, marginLeft: 4}}>
            Back
          </Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>All Brands</Text>
        <TouchableOpacity
          onPress={handleDone}
          disabled={saving}
          style={[styles.doneBtn, saving && styles.doneBtnDisabled]}>
          <Text style={styles.doneBtnText}>
            {saving ? 'Saving...' : `Done (${selectedCount})`}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <TextInput
          placeholder="Search brands..."
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      {/* Brand List */}
      <SectionList
        sections={sections}
        keyExtractor={item => item.id}
        renderSectionHeader={({section}) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{section.title}</Text>
          </View>
        )}
        renderItem={({item}) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => toggle(item.name)}
            activeOpacity={0.6}>
            <Text style={styles.rowText}>{item.name}</Text>
            {isSelected(item.name) && (
              <Icon name="check" size={20} color={colors.primary} />
            )}
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        getItemLayout={(_data, index) => ({
          length: 45,
          offset: 45 * index,
          index,
        })}
      />
    </View>
  );
}
