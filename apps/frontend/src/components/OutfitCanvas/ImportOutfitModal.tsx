import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import {useAppTheme} from '../../context/ThemeContext';
import {useUUID} from '../../context/UUIDContext';
import {useFavorites} from '../../hooks/useFavorites';
import {useOutfitsQuery, SavedOutfitData} from '../../hooks/useOutfitsData';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

const {height: SCREEN_HEIGHT} = Dimensions.get('window');

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelectOutfit: (outfit: SavedOutfitData) => void;
};

export default function ImportOutfitModal({
  visible,
  onClose,
  onSelectOutfit,
}: Props) {
  const {theme} = useAppTheme();
  const userId = useUUID();
  const {favorites} = useFavorites(userId || '');
  const {data: outfits, isLoading} = useOutfitsQuery(userId || '', favorites);

  const handleSelectOutfit = (outfit: SavedOutfitData) => {
    ReactNativeHapticFeedback.trigger('impactMedium', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
    onSelectOutfit(outfit);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getOutfitThumbnail = (outfit: SavedOutfitData): string => {
    if (outfit.thumbnailUrl) return outfit.thumbnailUrl;
    if (outfit.allItems && outfit.allItems.length > 0) {
      return outfit.allItems[0].image;
    }
    if (outfit.top?.image) return outfit.top.image;
    return '';
  };

  const getItemCount = (outfit: SavedOutfitData): number => {
    if (outfit.allItems) return outfit.allItems.length;
    return [outfit.top, outfit.bottom, outfit.shoes].filter(
      item => item && item.id,
    ).length;
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      justifyContent: 'flex-end',
    },
    modal: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: SCREEN_HEIGHT * 0.7,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: -4},
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 10,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder || 'rgba(0,0,0,0.1)',
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    closeButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.colors.foreground,
      justifyContent: 'center',
      alignItems: 'center',
    },
    content: {
      paddingVertical: 12,
    },
    loadingContainer: {
      paddingVertical: 60,
      alignItems: 'center',
    },
    emptyContainer: {
      paddingVertical: 60,
      alignItems: 'center',
    },
    emptyIcon: {
      marginBottom: 12,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.muted || theme.colors.foreground,
      textAlign: 'center',
    },
    emptySubtext: {
      fontSize: 14,
      color: theme.colors.muted || theme.colors.foreground,
      textAlign: 'center',
      marginTop: 4,
      opacity: 0.7,
    },
    outfitItem: {
      flexDirection: 'row',
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder || 'rgba(0,0,0,0.05)',
    },
    outfitThumbnail: {
      width: 70,
      height: 70,
      borderRadius: 10,
      backgroundColor: theme.colors.surface,
    },
    outfitInfo: {
      flex: 1,
      marginLeft: 14,
      justifyContent: 'center',
    },
    outfitName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
      marginBottom: 4,
    },
    outfitMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    typeBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 4,
      marginRight: 8,
    },
    customBadge: {
      backgroundColor: theme.colors.primary || '#007AFF',
    },
    aiBadge: {
      backgroundColor: '#8B5CF6',
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    itemCount: {
      fontSize: 13,
      color: theme.colors.muted || theme.colors.foreground,
    },
    outfitDate: {
      fontSize: 12,
      color: theme.colors.muted || theme.colors.foreground,
      opacity: 0.7,
    },
    chevron: {
      justifyContent: 'center',
      paddingLeft: 8,
    },
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.modal}>
              <View style={styles.header}>
                <Text style={styles.title}>Import From Saved Outfit</Text>
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={onClose}
                  activeOpacity={0.7}>
                  <MaterialIcons
                    name="close"
                    size={20}
                    color={theme.colors.background}
                  />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.content}
                showsVerticalScrollIndicator={false}>
                {isLoading ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator
                      size="large"
                      color={theme.colors.primary}
                    />
                  </View>
                ) : !outfits || outfits.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <MaterialIcons
                      name="folder-open"
                      size={48}
                      color={theme.colors.muted || theme.colors.foreground}
                      style={styles.emptyIcon}
                    />
                    <Text style={styles.emptyText}>No saved outfits yet</Text>
                    <Text style={styles.emptySubtext}>
                      Save an outfit first to import it here
                    </Text>
                  </View>
                ) : (
                  outfits.map(outfit => {
                    const thumbnailUri = getOutfitThumbnail(outfit);
                    const itemCount = getItemCount(outfit);

                    return (
                      <TouchableOpacity
                        key={outfit.id}
                        style={styles.outfitItem}
                        onPress={() => handleSelectOutfit(outfit)}
                        activeOpacity={0.7}>
                        {thumbnailUri ? (
                          <FastImage
                            source={{
                              uri: thumbnailUri,
                              priority: FastImage.priority.normal,
                            }}
                            style={styles.outfitThumbnail}
                            resizeMode={FastImage.resizeMode.cover}
                          />
                        ) : (
                          <View style={styles.outfitThumbnail} />
                        )}

                        <View style={styles.outfitInfo}>
                          <Text
                            style={styles.outfitName}
                            numberOfLines={1}
                            ellipsizeMode="tail">
                            {outfit.name || 'Untitled Outfit'}
                          </Text>

                          <View style={styles.outfitMeta}>
                            <View
                              style={[
                                styles.typeBadge,
                                outfit.type === 'custom'
                                  ? styles.customBadge
                                  : styles.aiBadge,
                              ]}>
                              <Text style={styles.badgeText}>
                                {outfit.type === 'custom' ? 'Custom' : 'AI'}
                              </Text>
                            </View>
                            <Text style={styles.itemCount}>
                              {itemCount} {itemCount === 1 ? 'item' : 'items'}
                            </Text>
                          </View>

                          <Text style={styles.outfitDate}>
                            {formatDate(outfit.createdAt)}
                          </Text>
                        </View>

                        <View style={styles.chevron}>
                          <MaterialIcons
                            name="chevron-right"
                            size={24}
                            color={theme.colors.muted || theme.colors.foreground}
                          />
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
