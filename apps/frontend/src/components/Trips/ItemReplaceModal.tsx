import React from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  StyleSheet,
  Pressable,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';
import {tokens} from '../../styles/tokens/tokens';
import {TripPackingItem, TripWardrobeItem} from '../../types/trips';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

type Props = {
  visible: boolean;
  currentItem: TripPackingItem | null;
  alternatives: TripWardrobeItem[];
  locationLabel: string;
  onReplace: (newItem: TripPackingItem) => void;
  onClose: () => void;
};

function getImageUrl(item: TripWardrobeItem): string {
  return (
    item.processedImageUrl ||
    item.touchedUpImageUrl ||
    item.thumbnailUrl ||
    item.image_url ||
    ''
  );
}

const ItemReplaceModal = ({
  visible,
  currentItem,
  alternatives,
  locationLabel,
  onReplace,
  onClose,
}: Props) => {
  const {theme} = useAppTheme();

  const filtered = alternatives.filter(
    a => currentItem && a.id !== currentItem.wardrobeItemId,
  );

  const handleSelect = (item: TripWardrobeItem) => {
    if (!currentItem) return;
    const newPacking: TripPackingItem = {
      id: `trip_${item.id}`,
      wardrobeItemId: item.id,
      name: item.name || 'Unknown Item',
      imageUrl: getImageUrl(item),
      color: item.color,
      mainCategory: item.main_category || 'Other',
      subCategory: item.subcategory,
      locationLabel,
      packed: false,
    };
    onReplace(newPacking);
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '70%',
      paddingBottom: 40,
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.surfaceBorder,
      alignSelf: 'center',
      marginTop: 12,
      marginBottom: 8,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    subtitle: {
      fontSize: 13,
      color: theme.colors.foreground2,
      paddingHorizontal: 20,
      marginBottom: 12,
    },
    scrollContent: {
      paddingHorizontal: 20,
    },
    itemRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 8,
        marginHorizontal: -8,
        borderRadius: 10,
        borderBottomWidth: tokens.borderWidth.hairline,
        borderBottomColor: theme.colors.muted,
    },
    thumbWrap: {
      width: 56,
      height: 56,
      borderRadius: tokens.borderRadius.switch1,
      backgroundColor: theme.colors.imageBackground,
      overflow: 'hidden',
      padding: 6
    },
    thumb: {
      width: '100%',
      height: '100%',
    },
    itemInfo: {
      flex: 1,
    },
    itemName: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    itemColor: {
      fontSize: 13,
      color: theme.colors.foreground2,
      marginTop: 2,
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.foreground2,
      textAlign: 'center',
      paddingVertical: 40,
    },
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Replace Item</Text>
            <AppleTouchFeedback onPress={onClose} hapticStyle="impactLight">
              <View style={{backgroundColor: 'white', borderRadius: 50, borderWidth: tokens.borderWidth.hairline, borderColor: 'black', padding: 6}}>
                  <Icon name="close" size={22} color={'black'} />
              </View>
            </AppleTouchFeedback>
          </View>
          {currentItem && (
            <Text style={styles.subtitle}>
              Replacing "{currentItem.name}" with another{' '}
              {currentItem.mainCategory.toLowerCase()} item
            </Text>
          )}
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {filtered.length === 0 ? (
              <Text style={styles.emptyText}>
                No alternatives available in this category
              </Text>
            ) : (
              filtered.map(item => (
                <AppleTouchFeedback
                  key={item.id}
                  onPress={() => handleSelect(item)}
                  hapticStyle="impactLight">
                  <View style={styles.itemRow}>
                    <View style={styles.thumbWrap}>
                      {getImageUrl(item) ? (
                        <FastImage
                          source={{
                            uri: getImageUrl(item),
                            priority: FastImage.priority.low,
                          }}
                          style={styles.thumb}
                          resizeMode={FastImage.resizeMode.contain}
                        />
                      ) : null}
                    </View>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      {item.color && (
                        <Text style={styles.itemColor}>{item.color}</Text>
                      )}
                    </View>
                    <Icon
                      name="chevron-right"
                      size={20}
                      color={theme.colors.foreground2}
                    />
                  </View>
                </AppleTouchFeedback>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default ItemReplaceModal;
