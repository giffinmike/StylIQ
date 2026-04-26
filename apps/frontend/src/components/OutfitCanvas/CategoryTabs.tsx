import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ScrollView} from 'react-native';
import {useAppTheme} from '../../context/ThemeContext';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

export type Category = 'All' | 'Tops' | 'Bottoms' | 'Outerwear' | 'Dresses' | 'Skirts' | 'Shoes' | 'Accessories' | 'Bags' | 'Headwear' | 'Jewelry';

const CATEGORIES: Category[] = ['All', 'Tops', 'Bottoms', 'Outerwear', 'Dresses', 'Skirts', 'Shoes', 'Accessories', 'Bags', 'Headwear', 'Jewelry'];

type Props = {
  selectedCategory: Category;
  onSelectCategory: (category: Category) => void;
};

export default function CategoryTabs({
  selectedCategory,
  onSelectCategory,
}: Props) {
  const {theme} = useAppTheme();

  const handleSelect = (category: Category) => {
    ReactNativeHapticFeedback.trigger('selection', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
    onSelectCategory(category);
  };

  const styles = StyleSheet.create({
    container: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder || 'rgba(0,0,0,0.1)',
    },
    scrollContent: {
      paddingHorizontal: 12,
      gap: 8,
      flexDirection: 'row',
      marginBottom: 4
    },
    tab: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
    },
    tabSelected: {
      backgroundColor: theme.colors.button1,
      borderColor: theme.colors.button1,
    },
    tabText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.muted || theme.colors.foreground,
    },
    tabTextSelected: {
      color: theme.colors.buttonText1,
      fontWeight: '600',
    },
  });

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}>
        {CATEGORIES.map(category => {
          const isSelected = category === selectedCategory;
          return (
            <TouchableOpacity
              key={category}
              style={[styles.tab, isSelected && styles.tabSelected]}
              onPress={() => handleSelect(category)}
              activeOpacity={0.7}>
              <Text
                style={[styles.tabText, isSelected && styles.tabTextSelected]}>
                {category}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
