import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import FastImage from 'react-native-fast-image';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';
import {tokens} from '../../styles/tokens/tokens';
import {BackupSuggestion, PackingGroup, TripPackingItem} from '../../types/trips';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

type Props = {
  packingList: PackingGroup[];
  tripBackupKit?: BackupSuggestion[];
  onTogglePacked: (itemId: string) => void;
  onToggleBackupPacked: (wardrobeItemId: string) => void;
  onReplaceItem: (item: TripPackingItem) => void;
};

const PackingListSection = ({
  packingList,
  tripBackupKit,
  onTogglePacked,
  onToggleBackupPacked,
  onReplaceItem,
}: Props) => {
  const {theme} = useAppTheme();

  const backupCount = tripBackupKit?.length ?? 0;
  const backupPacked = tripBackupKit?.filter(b => b.packed).length ?? 0;
  const totalItems = packingList.reduce((s, g) => s + g.items.length, 0) + backupCount;
  const packedItems = packingList.reduce(
    (s, g) => s + g.items.filter(i => i.packed).length,
    0,
  ) + backupPacked;

  const styles = StyleSheet.create({
    container: {
      paddingHorizontal: tokens.spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: tokens.spacing.md,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    packedCount: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.foreground2,
    },
    groupHeader: {
      fontSize: 14,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginTop: tokens.spacing.md,
      marginBottom: tokens.spacing.xxs,
      textTransform: 'uppercase',
      letterSpacing: 1,
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
    itemRowPacked: {},
    checkbox: {
      width: 18,
      height: 18,
      borderRadius: 6,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: {
      backgroundColor: theme.colors.button1,
      borderColor: theme.colors.input,
    },
    checkboxUnchecked: {
      backgroundColor: 'transparent',
      borderColor: theme.colors.input,
    },
    thumbWrap: {
      width: 54,
      height: 54,
      borderRadius: tokens.borderRadius.switch1,
      backgroundColor: theme.colors.imageBackground,
      overflow: 'hidden',
      padding: 4
    },
    thumbPacked: {
      opacity: 0.4,
    },
    thumb: {
      width: '100%',
      height: '100%',
    },
    itemInfo: {
      flex: 1,
    },
    itemName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    itemNamePacked: {
      textDecorationLine: 'line-through',
      opacity: 0.5,
    },
    itemMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    },
    colorDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      borderWidth: 0.5,
      borderColor: 'rgb(255, 255, 255)',
    },
    locationBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    locationText: {
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.foreground2,
    },
    replaceBtn: {
      padding: 6,
    },
    backupHeader: {
      fontSize: 14,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginTop: tokens.spacing.lg,
      marginBottom: tokens.spacing.xs,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    backupRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: tokens.borderWidth.hairline,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    backupLabel: {
      fontSize: 11,
      fontWeight: '500',
      color: theme.colors.foreground2,
      marginTop: 2,
    },
    reminderCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: theme.colors.surface3,
      borderRadius: 10,
      padding: 12,
      marginBottom: tokens.spacing.sm,
    },
    reminderText: {
      flex: 1,
      fontSize: 12.5,
      fontWeight: '500',
      color: theme.colors.foreground,
      lineHeight: 18,
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Packing List</Text>
        <Text style={styles.packedCount}>
          {packedItems}/{totalItems} packed
        </Text>
      </View>

      <View style={styles.reminderCard}>
        <Icon name="lightbulb" size={20} color="#FFD600" />
        <Text style={styles.reminderText}>
          Don't forget to pack: socks, sleepwear, undergarments, swimwear, chargers, etc...
        </Text>
      </View>

      {packingList.map(group => (
        <View key={group.category}>
          <Text style={styles.groupHeader}>{group.category}</Text>
          {group.items.map(item => (
            <AppleTouchFeedback
              key={item.id}
              onPress={() => onTogglePacked(item.id)}
              hapticStyle="impactLight">
              <View
                style={[
                  styles.itemRow,
                  item.packed && styles.itemRowPacked,
                ]}>
                <View
                  style={[
                    styles.checkbox,
                    item.packed
                      ? styles.checkboxChecked
                      : styles.checkboxUnchecked,
                  ]}>
                  {item.packed && (
                    <Icon name="check" size={16} color="#FFFFFF" />
                  )}
                </View>

                <View
                  style={[
                    styles.thumbWrap,
                    item.packed && styles.thumbPacked,
                  ]}>
                  {item.imageUrl ? (
                    <FastImage
                      source={{
                        uri: item.imageUrl,
                        priority: FastImage.priority.low,
                      }}
                      style={styles.thumb}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  ) : null}
                </View>

                <View style={styles.itemInfo}>
                  <Text
                    style={[
                      styles.itemName,
                      item.packed && styles.itemNamePacked,
                    ]}
                    numberOfLines={1}>
                    {item.name}
                  </Text>

                  <View style={styles.itemMeta}>
                    {/* {item.color && (
                      <View
                        style={[
                          styles.colorDot,
                          {backgroundColor: item.color},
                        ]}
                      />
                    )} */}
                    <View style={styles.locationBadge}>
                      <Icon
                        name="place"
                        size={15}
                        color={'green'}
                      />

                      <Text style={styles.locationText}>
                        {item.locationLabel}
                      </Text>
                    </View>
                  </View>
                </View>

                <AppleTouchFeedback
                  onPress={() => onReplaceItem(item)}
                  style={styles.replaceBtn}
                  hapticStyle="impactLight">
                  <Icon
                    name="swap-horiz"
                    size={20}
                    color={theme.colors.foreground2}
                  />
                </AppleTouchFeedback>
              </View>
            </AppleTouchFeedback>
          ))}
        </View>
      ))}

      {tripBackupKit && tripBackupKit.length > 0 && (
        <View>
          <Text style={styles.backupHeader}>Backup Items</Text>
          {tripBackupKit.map(b => (
            <AppleTouchFeedback
              key={b.wardrobeItemId}
              onPress={() => onToggleBackupPacked(b.wardrobeItemId)}
              hapticStyle="impactLight">
              <View
                style={[
                  styles.itemRow,
                  b.packed && styles.itemRowPacked,
                ]}>
                <View
                  style={[
                    styles.checkbox,
                    b.packed
                      ? styles.checkboxChecked
                      : styles.checkboxUnchecked,
                  ]}>
                  {b.packed && (
                    <Icon name="check" size={16} color="#FFFFFF" />
                  )}
                </View>

                <View
                  style={[
                    styles.thumbWrap,
                    b.packed && styles.thumbPacked,
                  ]}>
                  {b.imageUrl ? (
                    <FastImage
                      source={{
                        uri: b.imageUrl,
                        priority: FastImage.priority.low,
                      }}
                      style={styles.thumb}
                      resizeMode={FastImage.resizeMode.contain}
                    />
                  ) : null}
                </View>

                <View style={styles.itemInfo}>
                  <Text
                    style={[
                      styles.itemName,
                      b.packed && styles.itemNamePacked,
                    ]}
                    numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text style={styles.backupLabel}>(backup)</Text>
                </View>
              </View>
            </AppleTouchFeedback>
          ))}
        </View>
      )}
    </View>
  );
};

export default PackingListSection;
