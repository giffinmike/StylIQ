import React from 'react';
import {View, Text, ScrollView, StyleSheet, Dimensions} from 'react-native';
import FastImage from 'react-native-fast-image';
import {useAppTheme} from '../../context/ThemeContext';
import {tokens} from '../../styles/tokens/tokens';
import {CapsuleOutfit, BackupSuggestion} from '../../types/trips';

const CARD_WIDTH = Dimensions.get('window').width * 0.75;
const THUMB_SIZE = (CARD_WIDTH - 48 - 10) / 2;
const BACKUP_KIT_IMG = 45;

/** Map activity to stylized label based on occurrence count */
function getStylizedLabel(
  activity: string | undefined,
  activityIndex: number,
  activityCount: number,
): string {
  const name = activity ?? 'Look';

  switch (name) {
    case 'Business':
      if (activityCount === 1) return 'Primary Business Look';
      return activityIndex === 0
        ? 'Primary Business Look'
        : `Business Look ${activityIndex + 1}`;
    case 'Formal':
      if (activityCount === 1) return 'Formal Evening';
      return `Formal Option ${activityIndex + 1}`;
    case 'Dinner':
      if (activityCount === 1) return 'Dinner Look';
      return activityIndex === 0
        ? 'Dinner Look'
        : `Dinner Option ${activityIndex + 1}`;
    case 'Casual':
      if (activityCount === 1) return 'Casual Look';
      return `Casual Look ${activityIndex + 1}`;
    case 'Beach':
      if (activityCount === 1) return 'Beach Look';
      return `Beach Look ${activityIndex + 1}`;
    case 'Active':
      if (activityCount === 1) return 'Active Look';
      return `Active Look ${activityIndex + 1}`;
    case 'Sightseeing':
      if (activityCount === 1) return 'Sightseeing Look';
      return `Sightseeing Look ${activityIndex + 1}`;
    case 'Cold Weather':
      if (activityCount === 1) return 'Cold Weather Look';
      return `Cold Weather Look ${activityIndex + 1}`;
    default:
      if (activityCount === 1) return `${name} Look`;
      return `${name} Look ${activityIndex + 1}`;
  }
}

/** Compute stylized labels for all outfits based on activity grouping */
function computeOutfitLabels(outfits: CapsuleOutfit[]): string[] {
  // Count occurrences of each activity (only anchor outfits)
  const activityCounts = new Map<string, number>();
  for (const outfit of outfits) {
    if ((outfit.type ?? 'anchor') !== 'anchor') continue;
    const key = outfit.occasion ?? 'Look';
    activityCounts.set(key, (activityCounts.get(key) ?? 0) + 1);
  }

  // Track running index per activity
  const activityIndex = new Map<string, number>();
  return outfits.map(outfit => {
    if ((outfit.type ?? 'anchor') !== 'anchor') {
      // Support outfits keep a simple label
      const key = outfit.occasion ?? 'Look';
      return `${key} Extra`;
    }
    const key = outfit.occasion ?? 'Look';
    const idx = activityIndex.get(key) ?? 0;
    activityIndex.set(key, idx + 1);
    return getStylizedLabel(key, idx, activityCounts.get(key) ?? 1);
  });
}

type Props = {
  outfits: CapsuleOutfit[];
  tripBackupKit?: BackupSuggestion[];
};

const OutfitCarousel = ({outfits, tripBackupKit}: Props) => {
  const {theme} = useAppTheme();

  const styles = StyleSheet.create({
    scrollContent: {
      paddingHorizontal: tokens.spacing.md,
      gap: 14,
    },
    card: {
      width: CARD_WIDTH,
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xl,

      overflow: 'hidden',
    },
    supportCard: {
      width: CARD_WIDTH,
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xl,
      borderStyle: 'dashed',
      overflow: 'hidden',
      opacity: 0.85,
    },
    cardHeader: {
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 10,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    dayLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    occasionBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: theme.colors.surface2,
    },
    occasionText: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.foreground2,
    },
    itemCount: {
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.foreground2,
      marginTop: 2,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 16,
      paddingBottom: 16,
      gap: 4,
    },
    thumbCell: {
      width: THUMB_SIZE,
    },
    thumbWrap: {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      borderRadius: tokens.borderRadius.switch1,
      // backgroundColor: theme.colors.surface2,
      backgroundColor: theme.colors.imageBackground,
      overflow: 'hidden',
    },
    thumb: {
      width: '100%',
      height: '100%',
    },
    itemName: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.foreground,
      marginTop: 4,
      paddingHorizontal: 2,
    },
    emptyCard: {
      width: CARD_WIDTH,
      height: 200,
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xl,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.foreground2,
    },
    backupKitSection: {
      paddingHorizontal: tokens.spacing.md,
      marginTop: tokens.spacing.lg,
    },
    backupKitTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: 4,
    },
    backupKitSubtitle: {
      fontSize: 12,
      fontWeight: '400',
      color: theme.colors.foreground2,
      marginBottom: 14,
    },
    backupKitItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 14,
      paddingVertical: 12,
      borderBottomWidth: tokens.borderWidth.hairline,
      borderBottomColor: theme.colors.muted,
    },
    backupKitDivider: {
      height: tokens.borderWidth.hairline,
      backgroundColor: theme.colors.muted,
    },
    backupKitImage: {
      width: BACKUP_KIT_IMG,
      height: BACKUP_KIT_IMG,
    },
    backupKitInfo: {
      flex: 1,
      paddingTop: 2,
    },
    backupKitName: {
      fontSize: 14,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    backupKitReason: {
      fontSize: 13,
      fontWeight: '400',
      color: theme.colors.foreground2,
      marginTop: 4,
      lineHeight: 18,
    },
  });

  const outfitLabels = computeOutfitLabels(outfits);

  if (outfits.length === 0) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyText}>
          Add items to your wardrobe to see outfits
        </Text>
      </View>
    );
  }

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        decelerationRate="fast"
        snapToInterval={CARD_WIDTH + 14}
        snapToAlignment="start">
        {outfits.map((outfit, idx) => {
          const isSupport = (outfit.type ?? 'anchor') === 'support';
          return (
          <View key={outfit.id} style={isSupport ? styles.supportCard : styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.headerRow}>
                <Text style={styles.dayLabel}>
                  {outfitLabels[idx]}{isSupport ? ' +' : ''}
                </Text>
                {outfit.occasion ? (
                  <View style={styles.occasionBadge}>
                    <Text style={styles.occasionText}>{outfit.occasion}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.itemCount}>
                {outfit.items.length} item{outfit.items.length !== 1 ? 's' : ''}
              </Text>
            </View>
            <View style={styles.grid}>
              {outfit.items.map(item => (
                <View key={item.id} style={styles.thumbCell}>
                  <View style={styles.thumbWrap}>
                    {item.imageUrl ? (
                      <FastImage
                        source={{
                          uri: item.imageUrl,
                          priority: FastImage.priority.normal,
                        }}
                        style={styles.thumb}
                        resizeMode={FastImage.resizeMode.contain}
                      />
                    ) : null}
                  </View>
                  <Text
                    style={styles.itemName}
                    numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          );
        })}
      </ScrollView>
      {tripBackupKit && tripBackupKit.length > 0 && (
        <View style={styles.backupKitSection}>
          <Text style={styles.backupKitTitle}>
            {'🧳 Smart Backup Kit'}
          </Text>
          <Text style={styles.backupKitSubtitle}>
            Reusable safety pieces for your whole trip
          </Text>
          {tripBackupKit.map((b, idx) => (
            <React.Fragment key={b.wardrobeItemId}>
              {/* {idx > 0 && <View style={styles.backupKitDivider} />} */}
            
              <View style={styles.backupKitItem}>
                {b.imageUrl ? (
                    <View style={{borderRadius: tokens.borderRadius.switch1, backgroundColor: theme.colors.imageBackground, padding: 6}}>
                  <FastImage
                    source={{
                      uri: b.imageUrl,
                      priority: FastImage.priority.low,
                    }}
                    style={styles.backupKitImage}
                    resizeMode={FastImage.resizeMode.contain}
                  />
                  </View>
                ) : (
                  <View style={styles.backupKitImage} />
                )}
                <View style={styles.backupKitInfo}>
                  <Text style={styles.backupKitName}>{b.name}</Text>
                  <Text style={styles.backupKitReason}>{b.reason}</Text>
                </View>
              </View>
            </React.Fragment>
          ))}
        </View>
      )}
    </View>
  );
};

export default OutfitCarousel;
