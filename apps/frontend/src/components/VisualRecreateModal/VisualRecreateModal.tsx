/* eslint-disable react-native/no-inline-styles */
import React, {useState, useCallback, useEffect} from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {tokens} from '../../styles/tokens/tokens';
import {useAppTheme} from '../../context/ThemeContext';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import IntegratedShopOverlay from '../ShopModal/IntegratedShopOverlay';
import {useUUID} from '../../context/UUIDContext';
import {useSaveRecreatedLook} from '../../hooks/useHomeData';

const {width: screenWidth} = Dimensions.get('window');
const CARD_WIDTH = (screenWidth - 60) / 2;
const SMALL_CARD_WIDTH = (screenWidth - 70) / 3;

interface Product {
  title: string;
  image: string | null;
  link: string;
  price: string | null;
  brand: string;
  source: string;
  rating?: number | null;
  reviews?: number | null;
}

interface OutfitPiece {
  category: string;
  item: string;
  color: string;
  material?: string;
  style?: string;
  searchQuery?: string;
  products: Product[];
}

interface VisualRecreateModalProps {
  visible: boolean;
  onClose: () => void;
  pieces?: OutfitPiece[];
  results?: any[]; // Legacy support
  source_image?: string;
  lookId?: string;
  lookName?: string;
  tags?: string[];
  onDelete?: (id: string) => void;
  onRename?: (id: string, newName: string) => void;
  onSave?: () => void; // Callback to refresh list after save
}

// Category icons mapping
const CATEGORY_ICONS: Record<string, string> = {
  Top: 'checkroom',
  Bottom: 'straighten',
  Outerwear: 'ac-unit',
  Shoes: 'directions-walk',
  Accessories: 'watch',
  Hat: 'face',
  Bag: 'shopping-bag',
  Jewelry: 'diamond',
  default: 'style',
};

function ProductCard({
  item,
  theme,
  onPress,
  small = false,
}: {
  item: Product;
  theme: any;
  onPress: (url: string) => void;
  small?: boolean;
}) {
  const cardWidth = small ? SMALL_CARD_WIDTH : CARD_WIDTH;

  const handlePress = useCallback(() => {
    if (item.link) {
      // ReactNativeHapticFeedback.trigger('impactMedium');
      onPress(item.link);
    }
  }, [item.link, onPress]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.85}
      style={{
        width: cardWidth,
        marginBottom: 12,
        marginRight: small ? 8 : 0,
         borderRadius: tokens.borderRadius.switch1,
        overflow: 'hidden',
      }}>
      {item.image ? (
        <Image
          source={{uri: item.image}}
          style={{width: cardWidth, height: cardWidth * (small ? 1 : 1.2)}}
          resizeMode="cover"
        />
      ) : (
        <View
          style={{
            width: cardWidth,
            height: cardWidth * (small ? 1 : 1.2),
            backgroundColor: 'red',
            justifyContent: 'center',
            alignItems: 'center',
             borderRadius: tokens.borderRadius.sm,
          }}>
          <MaterialIcons
            name="shopping-bag"
            size={small ? 24 : 40}
            color={theme.colors.muted}
          />
        </View>
      )}
      <View style={{paddingVertical: small ? 8 : 10}}>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foreground,
            fontSize: small ? 10 : 12,
            fontWeight: '500',
            lineHeight: small ? 14 : 16,
          }}>
          {item.title}
        </Text>
        {item.brand && (
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foreground2,
              fontSize: small ? 9 : 11,
              marginTop: 2,
            }}>
            {item.brand}
          </Text>
        )}
        {item.price && (
          <Text
            style={{
              color: theme.colors.primary,
              fontSize: small ? 12 : 14,
              fontWeight: '700',
              marginTop: 4,
            }}>
            {item.price}
          </Text>
        )}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 6,
          }}>
          <MaterialIcons
            name="shopping-cart"
            size={small ? 10 : 14}
            color={theme.colors.primary}
          />
          <Text
            style={{
              color: theme.colors.primary,
              fontSize: small ? 9 : 11,
              fontWeight: '600',
              marginLeft: 3,
            }}>
            Shop
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function PieceSection({
  piece,
  theme,
  onShopPress,
}: {
  piece: OutfitPiece;
  theme: any;
  onShopPress: (url: string) => void;
}) {
  const iconName = CATEGORY_ICONS[piece.category] || CATEGORY_ICONS.default;

  return (
    <View style={{marginBottom: 24}}>
      {/* Section Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 6,
          paddingBottom: 8,
          borderBottomColor: theme.colors.surface2,
        }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: theme.colors.foreground + '20',
            justifyContent: 'center',
            alignItems: 'center',
            marginRight: 12,
          }}>
          <MaterialIcons
            name={iconName}
            size={20}
            color={'theme.colors.buttonText1'}
          />
        </View>
        <View style={{flex: 1}}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 16,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}>
            {piece.category}
          </Text>
          <Text
            style={{
              color: theme.colors.foreground3,
              fontSize: 12,
              marginTop: 2,
              fontWeight: '500',
            }}>
            {piece.color} {piece.item}
            {piece.material ? ` • ${piece.material}` : ''}
          </Text>
        </View>
      </View>

      {/* Products Grid */}
      {piece.products && piece.products.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{paddingRight: 10}}>
          {piece.products.map((product, idx) => (
            <ProductCard
              key={`${piece.category}-product-${idx}`}
              item={product}
              theme={theme}
              onPress={onShopPress}
              small
            />
          ))}
        </ScrollView>
      ) : (
        <View
          style={{
            padding: 20,
            backgroundColor: theme.colors.surface2,
            borderRadius: tokens.borderRadius.sm,
            alignItems: 'center',
          }}>
          <MaterialIcons
            name="search-off"
            size={24}
            color={theme.colors.muted}
          />
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 12,
              marginTop: 8,
              textAlign: 'center',
            }}>
            No matches found for this piece
          </Text>
        </View>
      )}
    </View>
  );
}

export default function VisualRecreateModal({
  visible,
  onClose,
  pieces,
  results,
  source_image,
  lookId,
  lookName,
  tags: initialTags,
  onDelete,
  onRename,
  onSave,
}: VisualRecreateModalProps) {
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const [shopUrl, setShopUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(lookName || '');

  const uuidContext = useUUID();
  const userId =
    typeof uuidContext === 'string'
      ? uuidContext
      : (uuidContext as any)?.uuid || '';

  // TanStack Query mutation for saving recreated looks
  const saveRecreatedLookMutation = useSaveRecreatedLook();

  // Reset state when modal opens with new data
  useEffect(() => {
    if (visible) {
      setNewName(lookName || '');
      setSaved(false);
      setSaving(false);
      setIsRenaming(false);
    }
  }, [visible, lookName]);

  const handleShopPress = useCallback((url: string) => {
    setShopUrl(url);
  }, []);

  const handleClose = useCallback(() => {
    // ReactNativeHapticFeedback.trigger('impactLight');
    setSaved(false); // Reset saved state on close
    onClose();
  }, [onClose]);

  const handleDelete = useCallback(() => {
    if (!lookId) {
      Alert.alert('Cannot Delete', 'No look ID available.');
      return;
    }

    Alert.alert(
      'Delete Look',
      'Are you sure you want to delete this recreated look?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Call the parent's onDelete which handles the API call
            onDelete?.(lookId);
            onClose();
          },
        },
      ],
    );
  }, [lookId, onDelete, onClose]);

  const handleRename = useCallback(() => {
    if (!lookId || !newName.trim()) {
      return;
    }
    ReactNativeHapticFeedback.trigger('impactLight');
    onRename?.(lookId, newName.trim());
    setIsRenaming(false);
  }, [lookId, newName, onRename]);

  const handleStartRename = useCallback(() => {
    setNewName(lookName || '');
    setIsRenaming(true);
    ReactNativeHapticFeedback.trigger('impactLight');
  }, [lookName]);

  const handleCancelRename = useCallback(() => {
    setIsRenaming(false);
    setNewName(lookName || '');
  }, [lookName]);

  const handleSave = useCallback(() => {
    if (!userId || !pieces || pieces.length === 0) {
      Alert.alert('Cannot Save', 'No outfit data to save.');
      return;
    }

    setSaving(true);
    ReactNativeHapticFeedback.trigger('impactLight');

    // Use passed tags or extract from pieces
    const tags = initialTags?.length
      ? initialTags
      : (pieces
          .flatMap(p => [p.category, p.item, p.color, p.material, p.style])
          .filter(Boolean) as string[]);

    saveRecreatedLookMutation.mutate(
      {
        userId,
        source_image_url: source_image || '',
        generated_outfit: {pieces},
        tags,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setSaving(false);
          ReactNativeHapticFeedback.trigger('notificationSuccess');
          // Refresh the recreated looks list
          onSave?.();
        },
        onError: (err: any) => {
          console.error('Failed to save recreated look:', err);
          Alert.alert(
            'Save Failed',
            'Could not save this look. Please try again.',
          );
          ReactNativeHapticFeedback.trigger('notificationError');
          setSaving(false);
        },
      },
    );
  }, [
    userId,
    pieces,
    source_image,
    initialTags,
    onSave,
    saveRecreatedLookMutation,
  ]);

  // Calculate total products found
  const totalProducts =
    pieces?.reduce((sum, p) => sum + (p.products?.length || 0), 0) || 0;

  // Legacy mode: if we have results but no pieces, show flat grid
  const isLegacyMode = !pieces && results && results.length > 0;

  const hasPieces = pieces && pieces.length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          justifyContent: 'flex-end',
        }}>
        <View
          style={{
            width: '100%',
            height: '95%',
            backgroundColor: theme.colors.background,
            borderTopLeftRadius: tokens.borderRadius['2xl'],
            borderTopRightRadius: tokens.borderRadius['2xl'],
            overflow: 'hidden',
          }}>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 20,
              paddingTop: 10,
              paddingBottom: 4,
            }}>
            <View style={{flex: 1}}>
              <Text style={[globalStyles.sectionTitle, {marginTop: 8}]}>
                SAVED RECREATED STYLE
              </Text>
            </View>

            {/* Close Button */}
            <TouchableOpacity
              onPress={handleClose}
              style={{
                borderRadius: 20,
                borderWidth: tokens.borderWidth.hairline,
                backgroundColor: 'white',
                borderColor: theme.colors.muted,
                padding: 6,
                marginLeft: 12,
              }}>
              <MaterialIcons
                name="close"
                size={20}
                color={'black'}
              />
            </TouchableOpacity>
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              marginBottom: 10
            }}>
              
            {/* Save Button */}
            {hasPieces && (
              <TouchableOpacity
                onPress={handleSave}
                disabled={saving || saved}
                style={{
                  borderRadius: tokens.borderRadius.sm,
                  borderColor: theme.colors.muted,
                  borderWidth: tokens.borderWidth.hairline,
                  backgroundColor: theme.colors.button1,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: saving ? 0.6 : 1,
                }}>
                {saving ? (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.foreground}
                  />
                ) : (
                  <>
                    <MaterialIcons
                      name={saved ? 'check' : 'bookmark-outline'}
                      size={18}
                      color={
                        saved
                          ? theme.colors.buttonText1
                          : theme.colors.buttonText1
                      }
                    />
                    <Text
                      style={{
                        color: saved
                          ? theme.colors.buttonText1
                          : theme.colors.buttonText1,
                        fontSize: 12,
                        fontWeight: '600',
                        marginLeft: 4,
                      }}>
                      {saved ? 'Saved' : 'Save'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            {/* Rename Button */}
            {lookId && onRename && (
              <TouchableOpacity
                onPress={handleStartRename}
                style={{
                  // backgroundColor: saved
                  //   ? theme.colors.primary
                  //   : theme.colors.surface,
                  borderRadius: tokens.borderRadius.sm,
                  borderColor: theme.colors.muted,
                  borderWidth: tokens.borderWidth.hairline,
                   backgroundColor: theme.colors.button1,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: saving ? 0.6 : 1,
                }}>
                <MaterialIcons
                  name="edit"
                  size={18}
                  color={theme.colors.buttonText1}
                />
                <Text
                  style={{
                    color: theme.colors.buttonText1,
                    fontSize: 12,
                    fontWeight: '600',
                  }}>
                  Rename
                </Text>
              </TouchableOpacity>
            )}

            {/* Delete Button */}
            {lookId && onDelete && (
              <TouchableOpacity
                onPress={handleDelete}
                style={{
                  // backgroundColor: saved
                  //   ? theme.colors.primary
                  //   : theme.colors.surface,
                  borderRadius: tokens.borderRadius.sm,
                  borderColor: theme.colors.muted,
                  borderWidth: tokens.borderWidth.hairline,
                   backgroundColor: theme.colors.error,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: saving ? 0.6 : 1,
                }}>
                <MaterialIcons
                  name="delete-outline"
                  size={18}
                  color="white"
                />
                <Text
                  style={{
                    color: theme.colors.buttonText1,
                    fontSize: 12,
                    fontWeight: '600',
                  }}>
                  Delete
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Content */}
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: 40,
            }}>
            {hasPieces && (
              <Text
                style={{
                  color: theme.colors.foreground2,
                  fontSize: 12,
                  marginBottom: 22,
                }}>
                {pieces.length} pieces identified • {totalProducts} products
                found
              </Text>
            )}

            {/* Source Image Preview */}
            {source_image && (
              <View style={{marginBottom: 24, alignItems: 'center'}}>
                <Image
                  source={{uri: source_image}}
                  style={{
                    // width: screenWidth * 0.35,
                    // height: screenWidth * 0.45,
                    width: screenWidth * 0.4,
                    height: screenWidth * 0.5,
                    borderRadius: tokens.borderRadius.switch1,
                  }}
                  resizeMode="cover"
                />
                {/* Look Name Display or Edit */}
                {isRenaming ? (
                  <View
                    style={{
                      marginTop: 12,
                      width: '100%',
                      paddingHorizontal: 20,
                    }}>
                    <TextInput
                      value={newName}
                      onChangeText={setNewName}
                      placeholder="Enter look name"
                      placeholderTextColor={theme.colors.muted}
                      autoFocus
                      style={{
                        backgroundColor: theme.colors.surface,
                        borderRadius: tokens.borderRadius.md,
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        color: theme.colors.foreground,
                        fontSize: 14,
                        textAlign: 'center',
                      }}
                    />
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'center',
                        gap: 12,
                        marginTop: 12,
                      }}>
                      <TouchableOpacity
                        onPress={handleCancelRename}
                        style={{
                          borderRadius: tokens.borderRadius.sm,
                          borderColor: theme.colors.muted,
                          borderWidth: tokens.borderWidth.hairline,
                          paddingHorizontal: 20,
                          paddingVertical: 9,
                        }}>
                        <Text
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                          Cancel
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={handleRename}
                        style={{
                          borderRadius: tokens.borderRadius.sm,
                          borderColor: theme.colors.muted,
                          borderWidth: tokens.borderWidth.hairline,
                          paddingHorizontal: 20,
                          paddingVertical: 9,
                          backgroundColor: theme.colors.button1,
                        }}>
                        <Text
                          style={{
                            color: theme.colors.buttonText1,
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                          Save
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <>
                    {lookName && (
                      <Text
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 14,
                          fontWeight: '600',
                          marginTop: 10,
                          textAlign: 'center',
                        }}>
                        {lookName}
                      </Text>
                    )}
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 12,
                        marginTop: lookName ? 4 : 8,
                        textAlign: 'center',
                        fontWeight: '600',
                      }}>
                      Your Inspired Style
                    </Text>
                  </>
                )}
              </View>
            )}

            {/* Pieces by Category */}
            {hasPieces ? (
              pieces.map((piece, idx) => (
                <PieceSection
                  key={`piece-${idx}`}
                  piece={piece}
                  theme={theme}
                  onShopPress={handleShopPress}
                />
              ))
            ) : isLegacyMode ? (
              // Legacy flat grid for old results format
              <>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    fontWeight: '600',
                    marginBottom: 16,
                  }}>
                  {results.length} similar items found
                </Text>
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                  }}>
                  {results.map((item: any, idx: number) => (
                    <ProductCard
                      key={`result-${idx}`}
                      item={item}
                      theme={theme}
                      onPress={handleShopPress}
                    />
                  ))}
                </View>
              </>
            ) : (
              <View style={{alignItems: 'center', paddingTop: 40}}>
                <MaterialIcons
                  name="search-off"
                  size={48}
                  color={theme.colors.muted}
                />
                <Text
                  style={{
                    color: theme.colors.muted,
                    fontSize: 14,
                    marginTop: 12,
                    textAlign: 'center',
                  }}>
                  No outfit pieces identified.{'\n'}Try a different image.
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      </View>

      {/* Shop Overlay WebView */}
      <IntegratedShopOverlay
        visible={!!shopUrl}
        url={shopUrl}
        onClose={() => setShopUrl(null)}
      />
    </Modal>
  );
}

/////////////

// /* eslint-disable react-native/no-inline-styles */
// import React, {useState, useCallback} from 'react';
// import {
//   Modal,
//   View,
//   Text,
//   ScrollView,
//   Image,
//   TouchableOpacity,
//   Dimensions,
//   ActivityIndicator,
//   Alert,
//   TextInput,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import IntegratedShopOverlay from '../ShopModal/IntegratedShopOverlay';
// import {useUUID} from '../../context/UUIDContext';
// import {API_BASE_URL} from '../../config/api';

// const {width: screenWidth} = Dimensions.get('window');
// const CARD_WIDTH = (screenWidth - 60) / 2;
// const SMALL_CARD_WIDTH = (screenWidth - 70) / 3;

// interface Product {
//   title: string;
//   image: string | null;
//   link: string;
//   price: string | null;
//   brand: string;
//   source: string;
//   rating?: number | null;
//   reviews?: number | null;
// }

// interface OutfitPiece {
//   category: string;
//   item: string;
//   color: string;
//   material?: string;
//   style?: string;
//   searchQuery?: string;
//   products: Product[];
// }

// interface VisualRecreateModalProps {
//   visible: boolean;
//   onClose: () => void;
//   pieces?: OutfitPiece[];
//   results?: any[]; // Legacy support
//   source_image?: string;
//   lookId?: string;
//   lookName?: string;
//   tags?: string[];
//   onDelete?: (id: string) => void;
//   onRename?: (id: string, newName: string) => void;
//   onSave?: () => void; // Callback to refresh list after save
// }

// // Category icons mapping
// const CATEGORY_ICONS: Record<string, string> = {
//   Top: 'checkroom',
//   Bottom: 'straighten',
//   Outerwear: 'ac-unit',
//   Shoes: 'directions-walk',
//   Accessories: 'watch',
//   Hat: 'face',
//   Bag: 'shopping-bag',
//   Jewelry: 'diamond',
//   default: 'style',
// };

// function ProductCard({
//   item,
//   theme,
//   onPress,
//   small = false,
// }: {
//   item: Product;
//   theme: any;
//   onPress: (url: string) => void;
//   small?: boolean;
// }) {
//   const cardWidth = small ? SMALL_CARD_WIDTH : CARD_WIDTH;

//   const handlePress = useCallback(() => {
//     if (item.link) {
//       ReactNativeHapticFeedback.trigger('impactMedium');
//       onPress(item.link);
//     }
//   }, [item.link, onPress]);

//   return (
//     <TouchableOpacity
//       onPress={handlePress}
//       activeOpacity={0.85}
//       style={{
//         width: cardWidth,
//         marginBottom: 12,
//         marginRight: small ? 8 : 0,
//         backgroundColor: theme.colors.surface2,
//         borderRadius: tokens.borderRadius.lg,
//         overflow: 'hidden',
//       }}>
//       {item.image ? (
//         <Image
//           source={{uri: item.image}}
//           style={{width: cardWidth, height: cardWidth * (small ? 1 : 1.2)}}
//           resizeMode="cover"
//         />
//       ) : (
//         <View
//           style={{
//             width: cardWidth,
//             height: cardWidth * (small ? 1 : 1.2),
//             backgroundColor: theme.colors.surface3,
//             justifyContent: 'center',
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="shopping-bag"
//             size={small ? 24 : 40}
//             color={theme.colors.muted}
//           />
//         </View>
//       )}
//       <View style={{padding: small ? 8 : 10}}>
//         <Text
//           numberOfLines={2}
//           style={{
//             color: theme.colors.foreground,
//             fontSize: small ? 10 : 12,
//             fontWeight: '500',
//             lineHeight: small ? 14 : 16,
//           }}>
//           {item.title}
//         </Text>
//         {item.brand && (
//           <Text
//             numberOfLines={1}
//             style={{
//               color: theme.colors.muted,
//               fontSize: small ? 9 : 11,
//               marginTop: 2,
//             }}>
//             {item.brand}
//           </Text>
//         )}
//         {item.price && (
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 12 : 14,
//               fontWeight: '700',
//               marginTop: 4,
//             }}>
//             {item.price}
//           </Text>
//         )}
//         <View
//           style={{
//             flexDirection: 'row',
//             alignItems: 'center',
//             marginTop: 6,
//           }}>
//           <MaterialIcons
//             name="shopping-cart"
//             size={small ? 10 : 14}
//             color={theme.colors.primary}
//           />
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 9 : 11,
//               fontWeight: '600',
//               marginLeft: 3,
//             }}>
//             Shop
//           </Text>
//         </View>
//       </View>
//     </TouchableOpacity>
//   );
// }

// function PieceSection({
//   piece,
//   theme,
//   onShopPress,
// }: {
//   piece: OutfitPiece;
//   theme: any;
//   onShopPress: (url: string) => void;
// }) {
//   const iconName = CATEGORY_ICONS[piece.category] || CATEGORY_ICONS.default;

//   return (
//     <View style={{marginBottom: 24}}>
//       {/* Section Header */}
//       <View
//         style={{
//           flexDirection: 'row',
//           alignItems: 'center',
//           marginBottom: 12,
//           paddingBottom: 8,
//           borderBottomWidth: 1,
//           borderBottomColor: theme.colors.surface2,
//         }}>
//         <View
//           style={{
//             width: 36,
//             height: 36,
//             borderRadius: 18,
//             backgroundColor: theme.colors.primary + '20',
//             justifyContent: 'center',
//             alignItems: 'center',
//             marginRight: 12,
//           }}>
//           <MaterialIcons
//             name={iconName}
//             size={20}
//             color={theme.colors.primary}
//           />
//         </View>
//         <View style={{flex: 1}}>
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               fontSize: 16,
//               fontWeight: '700',
//               textTransform: 'uppercase',
//               letterSpacing: 0.5,
//             }}>
//             {piece.category}
//           </Text>
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 2,
//             }}>
//             {piece.color} {piece.item}
//             {piece.material ? ` • ${piece.material}` : ''}
//           </Text>
//         </View>
//       </View>

//       {/* Products Grid */}
//       {piece.products && piece.products.length > 0 ? (
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 10}}>
//           {piece.products.map((product, idx) => (
//             <ProductCard
//               key={`${piece.category}-product-${idx}`}
//               item={product}
//               theme={theme}
//               onPress={onShopPress}
//               small
//             />
//           ))}
//         </ScrollView>
//       ) : (
//         <View
//           style={{
//             padding: 20,
//             backgroundColor: theme.colors.surface2,
//             borderRadius: tokens.borderRadius.md,
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="search-off"
//             size={24}
//             color={theme.colors.muted}
//           />
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 8,
//               textAlign: 'center',
//             }}>
//             No matches found for this piece
//           </Text>
//         </View>
//       )}
//     </View>
//   );
// }

// export default function VisualRecreateModal({
//   visible,
//   onClose,
//   pieces,
//   results,
//   source_image,
//   lookId,
//   lookName,
//   tags: initialTags,
//   onDelete,
//   onRename,
//   onSave,
// }: VisualRecreateModalProps) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const [shopUrl, setShopUrl] = useState<string | null>(null);
//   const [saving, setSaving] = useState(false);
//   const [saved, setSaved] = useState(false);
//   const [isRenaming, setIsRenaming] = useState(false);
//   const [newName, setNewName] = useState(lookName || '');

//   const uuidContext = useUUID();
//   const userId =
//     typeof uuidContext === 'string'
//       ? uuidContext
//       : (uuidContext as any)?.uuid || '';

//   const handleShopPress = useCallback((url: string) => {
//     setShopUrl(url);
//   }, []);

//   const handleClose = useCallback(() => {
//     ReactNativeHapticFeedback.trigger('impactLight');
//     setSaved(false); // Reset saved state on close
//     onClose();
//   }, [onClose]);

//   const handleDelete = useCallback(() => {
//     if (!lookId) {
//       Alert.alert('Cannot Delete', 'No look ID available.');
//       return;
//     }

//     Alert.alert(
//       'Delete Look',
//       'Are you sure you want to delete this recreated look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => {
//             // Call the parent's onDelete which handles the API call
//             onDelete?.(lookId);
//             onClose();
//           },
//         },
//       ],
//     );
//   }, [lookId, onDelete, onClose]);

//   const handleRename = useCallback(() => {
//     if (!lookId || !newName.trim()) {
//       return;
//     }
//     ReactNativeHapticFeedback.trigger('impactLight');
//     onRename?.(lookId, newName.trim());
//     setIsRenaming(false);
//   }, [lookId, newName, onRename]);

//   const handleStartRename = useCallback(() => {
//     setNewName(lookName || '');
//     setIsRenaming(true);
//     ReactNativeHapticFeedback.trigger('impactLight');
//   }, [lookName]);

//   const handleCancelRename = useCallback(() => {
//     setIsRenaming(false);
//     setNewName(lookName || '');
//   }, [lookName]);

//   const handleSave = useCallback(async () => {
//     if (!userId || !pieces || pieces.length === 0) {
//       Alert.alert('Cannot Save', 'No outfit data to save.');
//       return;
//     }

//     setSaving(true);
//     ReactNativeHapticFeedback.trigger('impactLight');

//     try {
//       // Use passed tags or extract from pieces
//       const tags = initialTags?.length
//         ? initialTags
//         : (pieces
//             .flatMap(p => [p.category, p.item, p.color, p.material, p.style])
//             .filter(Boolean) as string[]);

//       const response = await fetch(
//         `${API_BASE_URL}/users/${userId}/recreated-looks`,
//         {
//           method: 'POST',
//           headers: {'Content-Type': 'application/json'},
//           body: JSON.stringify({
//             source_image_url: source_image,
//             generated_outfit: {pieces},
//             tags,
//             name: lookName || null,
//           }),
//         },
//       );

//       if (!response.ok) {
//         throw new Error('Failed to save recreated look');
//       }

//       setSaved(true);
//       ReactNativeHapticFeedback.trigger('notificationSuccess');

//       // Refresh the recreated looks list
//       onSave?.();
//     } catch (err: any) {
//       console.error('Failed to save recreated look:', err);
//       Alert.alert('Save Failed', 'Could not save this look. Please try again.');
//       ReactNativeHapticFeedback.trigger('notificationError');
//     } finally {
//       setSaving(false);
//     }
//   }, [userId, pieces, source_image, lookName, initialTags, onSave]);

//   if (!visible) return null;

//   // Calculate total products found
//   const totalProducts =
//     pieces?.reduce((sum, p) => sum + (p.products?.length || 0), 0) || 0;

//   // Legacy mode: if we have results but no pieces, show flat grid
//   const isLegacyMode = !pieces && results && results.length > 0;

//   const hasPieces = pieces && pieces.length > 0;

//   return (
//     <Modal visible={visible} animationType="slide" transparent>
//       <View
//         style={{
//           flex: 1,
//           backgroundColor: 'rgba(0,0,0,0.5)',
//           justifyContent: 'flex-end',
//         }}>
//         <View
//           style={{
//             width: '100%',
//             height: '100%',
//             backgroundColor: theme.colors.background,
//             borderTopLeftRadius: tokens.borderRadius['2xl'],
//             borderTopRightRadius: tokens.borderRadius['2xl'],
//             overflow: 'hidden',
//           }}>
//           {/* Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               justifyContent: 'space-between',
//               paddingHorizontal: 20,
//               paddingTop: 20,
//               paddingBottom: 12,
//               borderBottomWidth: 1,
//               borderBottomColor: theme.colors.surface2,
//               marginTop: 30,
//             }}>
//             <View style={{flex: 1}}>
//               <Text style={[globalStyles.sectionTitle, {marginTop: 46}]}>
//                 RECREATE THIS LOOK
//               </Text>
//               {hasPieces && (
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 12,
//                     marginTop: 4,
//                   }}>
//                   {pieces.length} pieces identified • {totalProducts} products
//                   found
//                 </Text>
//               )}
//             </View>
//             <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
//               {/* Save Button */}
//               {hasPieces && (
//                 <TouchableOpacity
//                   onPress={handleSave}
//                   disabled={saving || saved}
//                   style={{
//                     backgroundColor: saved
//                       ? theme.colors.primary
//                       : theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'column',
//                     alignItems: 'center',
//                     opacity: saving ? 0.6 : 1,
//                   }}>
//                   {saving ? (
//                     <ActivityIndicator
//                       size="small"
//                       color={theme.colors.foreground}
//                     />
//                   ) : (
//                     <>
//                       <MaterialIcons
//                         name={saved ? 'check' : 'bookmark-outline'}
//                         size={18}
//                         color={
//                           saved
//                             ? theme.colors.background
//                             : theme.colors.foreground
//                         }
//                       />
//                       <Text
//                         style={{
//                           color: saved
//                             ? theme.colors.background
//                             : theme.colors.foreground,
//                           fontSize: 12,
//                           fontWeight: '600',
//                           marginLeft: 4,
//                         }}>
//                         {saved ? 'Saved' : 'Save'}
//                       </Text>
//                     </>
//                   )}
//                 </TouchableOpacity>
//               )}

//               {/* Rename Button */}
//               {lookId && onRename && (
//                 <TouchableOpacity
//                   onPress={handleStartRename}
//                   style={{
//                     backgroundColor: theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'column',
//                     alignItems: 'center',
//                   }}>
//                   <MaterialIcons
//                     name="edit"
//                     size={18}
//                     color={theme.colors.primary}
//                   />
//                   <Text
//                     style={{
//                       color: theme.colors.primary,
//                       fontSize: 12,
//                       fontWeight: '600',
//                     }}>
//                     Rename
//                   </Text>
//                 </TouchableOpacity>
//               )}

//               {/* Delete Button */}
//               {lookId && onDelete && (
//                 <TouchableOpacity
//                   onPress={handleDelete}
//                   style={{
//                     backgroundColor: theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'column',
//                     alignItems: 'center',
//                   }}>
//                   <MaterialIcons
//                     name="delete-outline"
//                     size={18}
//                     color="#ef4444"
//                   />
//                   <Text
//                     style={{
//                       color: theme.colors.error,
//                       fontSize: 12,
//                       fontWeight: '600',
//                     }}>
//                     Delete
//                   </Text>
//                 </TouchableOpacity>
//               )}

//               {/* Close Button */}
//               <TouchableOpacity
//                 onPress={handleClose}
//                 style={{
//                   backgroundColor: theme.colors.foreground,
//                   borderRadius: 20,
//                   padding: 6,
//                   marginLeft: 12,
//                 }}>
//                 <MaterialIcons
//                   name="close"
//                   size={20}
//                   color={theme.colors.background}
//                 />
//               </TouchableOpacity>
//             </View>
//           </View>

//           {/* Content */}
//           <ScrollView
//             showsVerticalScrollIndicator={false}
//             contentContainerStyle={{
//               paddingHorizontal: 20,
//               paddingTop: 16,
//               paddingBottom: 40,
//             }}>
//             {/* Source Image Preview */}
//             {source_image && (
//               <View style={{marginBottom: 24, alignItems: 'center'}}>
//                 <Image
//                   source={{uri: source_image}}
//                   style={{
//                     width: screenWidth * 0.35,
//                     height: screenWidth * 0.45,
//                     borderRadius: tokens.borderRadius.lg,
//                   }}
//                   resizeMode="cover"
//                 />
//                 {/* Look Name Display or Edit */}
//                 {isRenaming ? (
//                   <View style={{marginTop: 12, width: '100%', paddingHorizontal: 20}}>
//                     <TextInput
//                       value={newName}
//                       onChangeText={setNewName}
//                       placeholder="Enter look name"
//                       placeholderTextColor={theme.colors.muted}
//                       autoFocus
//                       style={{
//                         backgroundColor: theme.colors.surface2,
//                         borderRadius: tokens.borderRadius.md,
//                         paddingHorizontal: 16,
//                         paddingVertical: 12,
//                         color: theme.colors.foreground,
//                         fontSize: 14,
//                         textAlign: 'center',
//                       }}
//                     />
//                     <View style={{flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 12}}>
//                       <TouchableOpacity
//                         onPress={handleCancelRename}
//                         style={{
//                           backgroundColor: theme.colors.surface2,
//                           borderRadius: 20,
//                           paddingHorizontal: 20,
//                           paddingVertical: 8,
//                         }}>
//                         <Text style={{color: theme.colors.foreground, fontSize: 14, fontWeight: '600'}}>
//                           Cancel
//                         </Text>
//                       </TouchableOpacity>
//                       <TouchableOpacity
//                         onPress={handleRename}
//                         style={{
//                           backgroundColor: theme.colors.primary,
//                           borderRadius: 20,
//                           paddingHorizontal: 20,
//                           paddingVertical: 8,
//                         }}>
//                         <Text style={{color: theme.colors.background, fontSize: 14, fontWeight: '600'}}>
//                           Save
//                         </Text>
//                       </TouchableOpacity>
//                     </View>
//                   </View>
//                 ) : (
//                   <>
//                     {lookName && (
//                       <Text
//                         style={{
//                           color: theme.colors.foreground,
//                           fontSize: 14,
//                           fontWeight: '600',
//                           marginTop: 10,
//                           textAlign: 'center',
//                         }}>
//                         {lookName}
//                       </Text>
//                     )}
//                     <Text
//                       style={{
//                         color: theme.colors.muted,
//                         fontSize: 11,
//                         marginTop: lookName ? 4 : 8,
//                         textAlign: 'center',
//                       }}>
//                       Your inspiration look
//                     </Text>
//                   </>
//                 )}
//               </View>
//             )}

//             {/* Pieces by Category */}
//             {hasPieces ? (
//               pieces.map((piece, idx) => (
//                 <PieceSection
//                   key={`piece-${idx}`}
//                   piece={piece}
//                   theme={theme}
//                   onShopPress={handleShopPress}
//                 />
//               ))
//             ) : isLegacyMode ? (
//               // Legacy flat grid for old results format
//               <>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     fontSize: 14,
//                     fontWeight: '600',
//                     marginBottom: 16,
//                   }}>
//                   {results.length} similar items found
//                 </Text>
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     justifyContent: 'space-between',
//                   }}>
//                   {results.map((item: any, idx: number) => (
//                     <ProductCard
//                       key={`result-${idx}`}
//                       item={item}
//                       theme={theme}
//                       onPress={handleShopPress}
//                     />
//                   ))}
//                 </View>
//               </>
//             ) : (
//               <View style={{alignItems: 'center', paddingTop: 40}}>
//                 <MaterialIcons
//                   name="search-off"
//                   size={48}
//                   color={theme.colors.muted}
//                 />
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 14,
//                     marginTop: 12,
//                     textAlign: 'center',
//                   }}>
//                   No outfit pieces identified.{'\n'}Try a different image.
//                 </Text>
//               </View>
//             )}
//           </ScrollView>
//         </View>
//       </View>

//       {/* Shop Overlay WebView */}
//       <IntegratedShopOverlay
//         visible={!!shopUrl}
//         url={shopUrl}
//         onClose={() => setShopUrl(null)}
//       />
//     </Modal>
//   );
// }

///////////////////

// /* eslint-disable react-native/no-inline-styles */
// import React, {useState, useCallback} from 'react';
// import {
//   Modal,
//   View,
//   Text,
//   ScrollView,
//   Image,
//   TouchableOpacity,
//   Dimensions,
//   ActivityIndicator,
//   Alert,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import IntegratedShopOverlay from '../ShopModal/IntegratedShopOverlay';
// import {useUUID} from '../../context/UUIDContext';
// import {API_BASE_URL} from '../../config/api';

// const {width: screenWidth} = Dimensions.get('window');
// const CARD_WIDTH = (screenWidth - 60) / 2;
// const SMALL_CARD_WIDTH = (screenWidth - 70) / 3;

// interface Product {
//   title: string;
//   image: string | null;
//   link: string;
//   price: string | null;
//   brand: string;
//   source: string;
//   rating?: number | null;
//   reviews?: number | null;
// }

// interface OutfitPiece {
//   category: string;
//   item: string;
//   color: string;
//   material?: string;
//   style?: string;
//   searchQuery?: string;
//   products: Product[];
// }

// interface VisualRecreateModalProps {
//   visible: boolean;
//   onClose: () => void;
//   pieces?: OutfitPiece[];
//   results?: any[]; // Legacy support
//   source_image?: string;
//   lookId?: string;
//   onDelete?: (id: string) => void;
// }

// // Category icons mapping
// const CATEGORY_ICONS: Record<string, string> = {
//   Top: 'checkroom',
//   Bottom: 'straighten',
//   Outerwear: 'ac-unit',
//   Shoes: 'directions-walk',
//   Accessories: 'watch',
//   Hat: 'face',
//   Bag: 'shopping-bag',
//   Jewelry: 'diamond',
//   default: 'style',
// };

// function ProductCard({
//   item,
//   theme,
//   onPress,
//   small = false,
// }: {
//   item: Product;
//   theme: any;
//   onPress: (url: string) => void;
//   small?: boolean;
// }) {
//   const cardWidth = small ? SMALL_CARD_WIDTH : CARD_WIDTH;

//   const handlePress = useCallback(() => {
//     if (item.link) {
//       ReactNativeHapticFeedback.trigger('impactMedium');
//       onPress(item.link);
//     }
//   }, [item.link, onPress]);

//   return (
//     <TouchableOpacity
//       onPress={handlePress}
//       activeOpacity={0.85}
//       style={{
//         width: cardWidth,
//         marginBottom: 12,
//         marginRight: small ? 8 : 0,
//         backgroundColor: theme.colors.surface2,
//         borderRadius: tokens.borderRadius.lg,
//         overflow: 'hidden',
//       }}>
//       {item.image ? (
//         <Image
//           source={{uri: item.image}}
//           style={{width: cardWidth, height: cardWidth * (small ? 1 : 1.2)}}
//           resizeMode="cover"
//         />
//       ) : (
//         <View
//           style={{
//             width: cardWidth,
//             height: cardWidth * (small ? 1 : 1.2),
//             backgroundColor: theme.colors.surface3,
//             justifyContent: 'center',
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="shopping-bag"
//             size={small ? 24 : 40}
//             color={theme.colors.muted}
//           />
//         </View>
//       )}
//       <View style={{padding: small ? 8 : 10}}>
//         <Text
//           numberOfLines={2}
//           style={{
//             color: theme.colors.foreground,
//             fontSize: small ? 10 : 12,
//             fontWeight: '500',
//             lineHeight: small ? 14 : 16,
//           }}>
//           {item.title}
//         </Text>
//         {item.brand && (
//           <Text
//             numberOfLines={1}
//             style={{
//               color: theme.colors.muted,
//               fontSize: small ? 9 : 11,
//               marginTop: 2,
//             }}>
//             {item.brand}
//           </Text>
//         )}
//         {item.price && (
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 12 : 14,
//               fontWeight: '700',
//               marginTop: 4,
//             }}>
//             {item.price}
//           </Text>
//         )}
//         <View
//           style={{
//             flexDirection: 'row',
//             alignItems: 'center',
//             marginTop: 6,
//           }}>
//           <MaterialIcons
//             name="shopping-cart"
//             size={small ? 10 : 14}
//             color={theme.colors.primary}
//           />
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 9 : 11,
//               fontWeight: '600',
//               marginLeft: 3,
//             }}>
//             Shop
//           </Text>
//         </View>
//       </View>
//     </TouchableOpacity>
//   );
// }

// function PieceSection({
//   piece,
//   theme,
//   onShopPress,
// }: {
//   piece: OutfitPiece;
//   theme: any;
//   onShopPress: (url: string) => void;
// }) {
//   const iconName = CATEGORY_ICONS[piece.category] || CATEGORY_ICONS.default;

//   return (
//     <View style={{marginBottom: 24}}>
//       {/* Section Header */}
//       <View
//         style={{
//           flexDirection: 'row',
//           alignItems: 'center',
//           marginBottom: 12,
//           paddingBottom: 8,
//           borderBottomWidth: 1,
//           borderBottomColor: theme.colors.surface2,
//         }}>
//         <View
//           style={{
//             width: 36,
//             height: 36,
//             borderRadius: 18,
//             backgroundColor: theme.colors.primary + '20',
//             justifyContent: 'center',
//             alignItems: 'center',
//             marginRight: 12,
//           }}>
//           <MaterialIcons
//             name={iconName}
//             size={20}
//             color={theme.colors.primary}
//           />
//         </View>
//         <View style={{flex: 1}}>
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               fontSize: 16,
//               fontWeight: '700',
//               textTransform: 'uppercase',
//               letterSpacing: 0.5,
//             }}>
//             {piece.category}
//           </Text>
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 2,
//             }}>
//             {piece.color} {piece.item}
//             {piece.material ? ` • ${piece.material}` : ''}
//           </Text>
//         </View>
//       </View>

//       {/* Products Grid */}
//       {piece.products && piece.products.length > 0 ? (
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 10}}>
//           {piece.products.map((product, idx) => (
//             <ProductCard
//               key={`${piece.category}-product-${idx}`}
//               item={product}
//               theme={theme}
//               onPress={onShopPress}
//               small
//             />
//           ))}
//         </ScrollView>
//       ) : (
//         <View
//           style={{
//             padding: 20,
//             backgroundColor: theme.colors.surface2,
//             borderRadius: tokens.borderRadius.md,
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="search-off"
//             size={24}
//             color={theme.colors.muted}
//           />
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 8,
//               textAlign: 'center',
//             }}>
//             No matches found for this piece
//           </Text>
//         </View>
//       )}
//     </View>
//   );
// }

// export default function VisualRecreateModal({
//   visible,
//   onClose,
//   pieces,
//   results,
//   source_image,
//   lookId,
//   onDelete,
// }: VisualRecreateModalProps) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const [shopUrl, setShopUrl] = useState<string | null>(null);
//   const [saving, setSaving] = useState(false);
//   const [saved, setSaved] = useState(false);

//   const uuidContext = useUUID();
//   const userId =
//     typeof uuidContext === 'string'
//       ? uuidContext
//       : (uuidContext as any)?.uuid || '';

//   const handleShopPress = useCallback((url: string) => {
//     setShopUrl(url);
//   }, []);

//   const handleClose = useCallback(() => {
//     ReactNativeHapticFeedback.trigger('impactLight');
//     setSaved(false); // Reset saved state on close
//     onClose();
//   }, [onClose]);

//   const handleDelete = useCallback(() => {
//     if (!lookId) {
//       Alert.alert('Cannot Delete', 'No look ID available.');
//       return;
//     }

//     Alert.alert(
//       'Delete Look',
//       'Are you sure you want to delete this recreated look?',
//       [
//         {text: 'Cancel', style: 'cancel'},
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: () => {
//             // Call the parent's onDelete which handles the API call
//             onDelete?.(lookId);
//             onClose();
//           },
//         },
//       ],
//     );
//   }, [lookId, onDelete, onClose]);

//   const handleSave = useCallback(async () => {
//     if (!userId || !pieces || pieces.length === 0) {
//       Alert.alert('Cannot Save', 'No outfit data to save.');
//       return;
//     }

//     setSaving(true);
//     ReactNativeHapticFeedback.trigger('impactLight');

//     try {
//       // Extract tags from pieces for easier searching later
//       const tags = pieces
//         .flatMap(p => [p.category, p.item, p.color, p.material, p.style])
//         .filter(Boolean) as string[];

//       const response = await fetch(
//         `${API_BASE_URL}/users/${userId}/recreated-looks`,
//         {
//           method: 'POST',
//           headers: {'Content-Type': 'application/json'},
//           body: JSON.stringify({
//             source_image_url: source_image,
//             generated_outfit: {pieces},
//             tags,
//           }),
//         },
//       );

//       if (!response.ok) {
//         throw new Error('Failed to save recreated look');
//       }

//       setSaved(true);
//       ReactNativeHapticFeedback.trigger('notificationSuccess');
//     } catch (err: any) {
//       console.error('Failed to save recreated look:', err);
//       Alert.alert('Save Failed', 'Could not save this look. Please try again.');
//       ReactNativeHapticFeedback.trigger('notificationError');
//     } finally {
//       setSaving(false);
//     }
//   }, [userId, pieces, source_image]);

//   if (!visible) return null;

//   // Calculate total products found
//   const totalProducts =
//     pieces?.reduce((sum, p) => sum + (p.products?.length || 0), 0) || 0;

//   // Legacy mode: if we have results but no pieces, show flat grid
//   const isLegacyMode = !pieces && results && results.length > 0;

//   const hasPieces = pieces && pieces.length > 0;

//   return (
//     <Modal visible={visible} animationType="slide" transparent>
//       <View
//         style={{
//           flex: 1,
//           backgroundColor: 'rgba(0,0,0,0.5)',
//           justifyContent: 'flex-end',
//         }}>
//         <View
//           style={{
//             width: '100%',
//             height: '92%',
//             backgroundColor: theme.colors.background,
//             borderTopLeftRadius: tokens.borderRadius['2xl'],
//             borderTopRightRadius: tokens.borderRadius['2xl'],
//             overflow: 'hidden',
//           }}>
//           {/* Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               justifyContent: 'space-between',
//               paddingHorizontal: 20,
//               paddingTop: 20,
//               paddingBottom: 12,
//               borderBottomWidth: 1,
//               borderBottomColor: theme.colors.surface2,
//             }}>
//             <View style={{flex: 1}}>
//               <Text style={[globalStyles.sectionTitle, {marginTop: 0}]}>
//                 RECREATE THIS LOOK
//               </Text>
//               {hasPieces && (
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 12,
//                     marginTop: 4,
//                   }}>
//                   {pieces.length} pieces identified • {totalProducts} products
//                   found
//                 </Text>
//               )}
//             </View>
//             <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
//               {/* Delete Button */}
//               {lookId && onDelete && (
//                 <TouchableOpacity
//                   onPress={handleDelete}
//                   style={{
//                     backgroundColor: theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                   }}>
//                   <MaterialIcons
//                     name="delete-outline"
//                     size={18}
//                     color="#ef4444"
//                   />
//                 </TouchableOpacity>
//               )}
//               {/* Save Button */}
//               {hasPieces && (
//                 <TouchableOpacity
//                   onPress={handleSave}
//                   disabled={saving || saved}
//                   style={{
//                     backgroundColor: saved
//                       ? theme.colors.primary
//                       : theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     opacity: saving ? 0.6 : 1,
//                   }}>
//                   {saving ? (
//                     <ActivityIndicator
//                       size="small"
//                       color={theme.colors.foreground}
//                     />
//                   ) : (
//                     <>
//                       <MaterialIcons
//                         name={saved ? 'check' : 'bookmark-outline'}
//                         size={18}
//                         color={
//                           saved
//                             ? theme.colors.background
//                             : theme.colors.foreground
//                         }
//                       />
//                       <Text
//                         style={{
//                           color: saved
//                             ? theme.colors.background
//                             : theme.colors.foreground,
//                           fontSize: 12,
//                           fontWeight: '600',
//                           marginLeft: 4,
//                         }}>
//                         {saved ? 'Saved' : 'Save'}
//                       </Text>
//                     </>
//                   )}
//                 </TouchableOpacity>
//               )}
//               {/* Close Button */}
//               <TouchableOpacity
//                 onPress={handleClose}
//                 style={{
//                   backgroundColor: theme.colors.foreground,
//                   borderRadius: 20,
//                   padding: 6,
//                 }}>
//                 <MaterialIcons
//                   name="close"
//                   size={20}
//                   color={theme.colors.background}
//                 />
//               </TouchableOpacity>
//             </View>
//           </View>

//           {/* Content */}
//           <ScrollView
//             showsVerticalScrollIndicator={false}
//             contentContainerStyle={{
//               paddingHorizontal: 20,
//               paddingTop: 16,
//               paddingBottom: 40,
//             }}>
//             {/* Source Image Preview */}
//             {source_image && (
//               <View style={{marginBottom: 24, alignItems: 'center'}}>
//                 <Image
//                   source={{uri: source_image}}
//                   style={{
//                     width: screenWidth * 0.35,
//                     height: screenWidth * 0.45,
//                     borderRadius: tokens.borderRadius.lg,
//                   }}
//                   resizeMode="cover"
//                 />
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 11,
//                     marginTop: 8,
//                     textAlign: 'center',
//                   }}>
//                   Your inspiration look
//                 </Text>
//               </View>
//             )}

//             {/* Pieces by Category */}
//             {hasPieces ? (
//               pieces.map((piece, idx) => (
//                 <PieceSection
//                   key={`piece-${idx}`}
//                   piece={piece}
//                   theme={theme}
//                   onShopPress={handleShopPress}
//                 />
//               ))
//             ) : isLegacyMode ? (
//               // Legacy flat grid for old results format
//               <>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     fontSize: 14,
//                     fontWeight: '600',
//                     marginBottom: 16,
//                   }}>
//                   {results.length} similar items found
//                 </Text>
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     justifyContent: 'space-between',
//                   }}>
//                   {results.map((item: any, idx: number) => (
//                     <ProductCard
//                       key={`result-${idx}`}
//                       item={item}
//                       theme={theme}
//                       onPress={handleShopPress}
//                     />
//                   ))}
//                 </View>
//               </>
//             ) : (
//               <View style={{alignItems: 'center', paddingTop: 40}}>
//                 <MaterialIcons
//                   name="search-off"
//                   size={48}
//                   color={theme.colors.muted}
//                 />
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 14,
//                     marginTop: 12,
//                     textAlign: 'center',
//                   }}>
//                   No outfit pieces identified.{'\n'}Try a different image.
//                 </Text>
//               </View>
//             )}
//           </ScrollView>
//         </View>
//       </View>

//       {/* Shop Overlay WebView */}
//       <IntegratedShopOverlay
//         visible={!!shopUrl}
//         url={shopUrl}
//         onClose={() => setShopUrl(null)}
//       />
//     </Modal>
//   );
// }

////////////////

// /* eslint-disable react-native/no-inline-styles */
// import React, {useState, useCallback} from 'react';
// import {
//   Modal,
//   View,
//   Text,
//   ScrollView,
//   Image,
//   TouchableOpacity,
//   Dimensions,
//   ActivityIndicator,
//   Alert,
// } from 'react-native';
// import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {tokens} from '../../styles/tokens/tokens';
// import {useAppTheme} from '../../context/ThemeContext';
// import {useGlobalStyles} from '../../styles/useGlobalStyles';
// import IntegratedShopOverlay from '../ShopModal/IntegratedShopOverlay';
// import {useUUID} from '../../context/UUIDContext';
// import {API_BASE_URL} from '../../config/api';

// const {width: screenWidth} = Dimensions.get('window');
// const CARD_WIDTH = (screenWidth - 60) / 2;
// const SMALL_CARD_WIDTH = (screenWidth - 70) / 3;

// interface Product {
//   title: string;
//   image: string | null;
//   link: string;
//   price: string | null;
//   brand: string;
//   source: string;
//   rating?: number | null;
//   reviews?: number | null;
// }

// interface OutfitPiece {
//   category: string;
//   item: string;
//   color: string;
//   material?: string;
//   style?: string;
//   searchQuery?: string;
//   products: Product[];
// }

// interface VisualRecreateModalProps {
//   visible: boolean;
//   onClose: () => void;
//   pieces?: OutfitPiece[];
//   results?: any[]; // Legacy support
//   source_image?: string;
// }

// // Category icons mapping
// const CATEGORY_ICONS: Record<string, string> = {
//   Top: 'checkroom',
//   Bottom: 'straighten',
//   Outerwear: 'ac-unit',
//   Shoes: 'directions-walk',
//   Accessories: 'watch',
//   Hat: 'face',
//   Bag: 'shopping-bag',
//   Jewelry: 'diamond',
//   default: 'style',
// };

// function ProductCard({
//   item,
//   theme,
//   onPress,
//   small = false,
// }: {
//   item: Product;
//   theme: any;
//   onPress: (url: string) => void;
//   small?: boolean;
// }) {
//   const cardWidth = small ? SMALL_CARD_WIDTH : CARD_WIDTH;

//   const handlePress = useCallback(() => {
//     if (item.link) {
//       ReactNativeHapticFeedback.trigger('impactMedium');
//       onPress(item.link);
//     }
//   }, [item.link, onPress]);

//   return (
//     <TouchableOpacity
//       onPress={handlePress}
//       activeOpacity={0.85}
//       style={{
//         width: cardWidth,
//         marginBottom: 12,
//         marginRight: small ? 8 : 0,
//         backgroundColor: theme.colors.surface2,
//         borderRadius: tokens.borderRadius.lg,
//         overflow: 'hidden',
//       }}>
//       {item.image ? (
//         <Image
//           source={{uri: item.image}}
//           style={{width: cardWidth, height: cardWidth * (small ? 1 : 1.2)}}
//           resizeMode="cover"
//         />
//       ) : (
//         <View
//           style={{
//             width: cardWidth,
//             height: cardWidth * (small ? 1 : 1.2),
//             backgroundColor: theme.colors.surface3,
//             justifyContent: 'center',
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="shopping-bag"
//             size={small ? 24 : 40}
//             color={theme.colors.muted}
//           />
//         </View>
//       )}
//       <View style={{padding: small ? 8 : 10}}>
//         <Text
//           numberOfLines={2}
//           style={{
//             color: theme.colors.foreground,
//             fontSize: small ? 10 : 12,
//             fontWeight: '500',
//             lineHeight: small ? 14 : 16,
//           }}>
//           {item.title}
//         </Text>
//         {item.brand && (
//           <Text
//             numberOfLines={1}
//             style={{
//               color: theme.colors.muted,
//               fontSize: small ? 9 : 11,
//               marginTop: 2,
//             }}>
//             {item.brand}
//           </Text>
//         )}
//         {item.price && (
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 12 : 14,
//               fontWeight: '700',
//               marginTop: 4,
//             }}>
//             {item.price}
//           </Text>
//         )}
//         <View
//           style={{
//             flexDirection: 'row',
//             alignItems: 'center',
//             marginTop: 6,
//           }}>
//           <MaterialIcons
//             name="shopping-cart"
//             size={small ? 10 : 14}
//             color={theme.colors.primary}
//           />
//           <Text
//             style={{
//               color: theme.colors.primary,
//               fontSize: small ? 9 : 11,
//               fontWeight: '600',
//               marginLeft: 3,
//             }}>
//             Shop
//           </Text>
//         </View>
//       </View>
//     </TouchableOpacity>
//   );
// }

// function PieceSection({
//   piece,
//   theme,
//   onShopPress,
// }: {
//   piece: OutfitPiece;
//   theme: any;
//   onShopPress: (url: string) => void;
// }) {
//   const iconName = CATEGORY_ICONS[piece.category] || CATEGORY_ICONS.default;

//   return (
//     <View style={{marginBottom: 24}}>
//       {/* Section Header */}
//       <View
//         style={{
//           flexDirection: 'row',
//           alignItems: 'center',
//           marginBottom: 12,
//           paddingBottom: 8,
//           borderBottomWidth: 1,
//           borderBottomColor: theme.colors.surface2,
//         }}>
//         <View
//           style={{
//             width: 36,
//             height: 36,
//             borderRadius: 18,
//             backgroundColor: theme.colors.primary + '20',
//             justifyContent: 'center',
//             alignItems: 'center',
//             marginRight: 12,
//           }}>
//           <MaterialIcons
//             name={iconName}
//             size={20}
//             color={theme.colors.primary}
//           />
//         </View>
//         <View style={{flex: 1}}>
//           <Text
//             style={{
//               color: theme.colors.foreground,
//               fontSize: 16,
//               fontWeight: '700',
//               textTransform: 'uppercase',
//               letterSpacing: 0.5,
//             }}>
//             {piece.category}
//           </Text>
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 2,
//             }}>
//             {piece.color} {piece.item}
//             {piece.material ? ` • ${piece.material}` : ''}
//           </Text>
//         </View>
//       </View>

//       {/* Products Grid */}
//       {piece.products && piece.products.length > 0 ? (
//         <ScrollView
//           horizontal
//           showsHorizontalScrollIndicator={false}
//           contentContainerStyle={{paddingRight: 10}}>
//           {piece.products.map((product, idx) => (
//             <ProductCard
//               key={`${piece.category}-product-${idx}`}
//               item={product}
//               theme={theme}
//               onPress={onShopPress}
//               small
//             />
//           ))}
//         </ScrollView>
//       ) : (
//         <View
//           style={{
//             padding: 20,
//             backgroundColor: theme.colors.surface2,
//             borderRadius: tokens.borderRadius.md,
//             alignItems: 'center',
//           }}>
//           <MaterialIcons
//             name="search-off"
//             size={24}
//             color={theme.colors.muted}
//           />
//           <Text
//             style={{
//               color: theme.colors.muted,
//               fontSize: 12,
//               marginTop: 8,
//               textAlign: 'center',
//             }}>
//             No matches found for this piece
//           </Text>
//         </View>
//       )}
//     </View>
//   );
// }

// export default function VisualRecreateModal({
//   visible,
//   onClose,
//   pieces,
//   results,
//   source_image,
// }: VisualRecreateModalProps) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const [shopUrl, setShopUrl] = useState<string | null>(null);
//   const [saving, setSaving] = useState(false);
//   const [saved, setSaved] = useState(false);

//   const uuidContext = useUUID();
//   const userId =
//     typeof uuidContext === 'string'
//       ? uuidContext
//       : (uuidContext as any)?.uuid || '';

//   const handleShopPress = useCallback((url: string) => {
//     setShopUrl(url);
//   }, []);

//   const handleClose = useCallback(() => {
//     ReactNativeHapticFeedback.trigger('impactLight');
//     setSaved(false); // Reset saved state on close
//     onClose();
//   }, [onClose]);

//   const handleSave = useCallback(async () => {
//     if (!userId || !pieces || pieces.length === 0) {
//       Alert.alert('Cannot Save', 'No outfit data to save.');
//       return;
//     }

//     setSaving(true);
//     ReactNativeHapticFeedback.trigger('impactLight');

//     try {
//       // Extract tags from pieces for easier searching later
//       const tags = pieces
//         .flatMap(p => [p.category, p.item, p.color, p.material, p.style])
//         .filter(Boolean) as string[];

//       const response = await fetch(
//         `${API_BASE_URL}/users/${userId}/recreated-looks`,
//         {
//           method: 'POST',
//           headers: {'Content-Type': 'application/json'},
//           body: JSON.stringify({
//             source_image_url: source_image,
//             generated_outfit: {pieces},
//             tags,
//           }),
//         },
//       );

//       if (!response.ok) {
//         throw new Error('Failed to save recreated look');
//       }

//       setSaved(true);
//       ReactNativeHapticFeedback.trigger('notificationSuccess');
//     } catch (err: any) {
//       console.error('Failed to save recreated look:', err);
//       Alert.alert('Save Failed', 'Could not save this look. Please try again.');
//       ReactNativeHapticFeedback.trigger('notificationError');
//     } finally {
//       setSaving(false);
//     }
//   }, [userId, pieces, source_image]);

//   if (!visible) return null;

//   // Calculate total products found
//   const totalProducts =
//     pieces?.reduce((sum, p) => sum + (p.products?.length || 0), 0) || 0;

//   // Legacy mode: if we have results but no pieces, show flat grid
//   const isLegacyMode = !pieces && results && results.length > 0;

//   const hasPieces = pieces && pieces.length > 0;

//   return (
//     <Modal visible={visible} animationType="slide" transparent>
//       <View
//         style={{
//           flex: 1,
//           backgroundColor: 'rgba(0,0,0,0.5)',
//           justifyContent: 'flex-end',
//         }}>
//         <View
//           style={{
//             width: '100%',
//             height: '92%',
//             backgroundColor: theme.colors.background,
//             borderTopLeftRadius: tokens.borderRadius['2xl'],
//             borderTopRightRadius: tokens.borderRadius['2xl'],
//             overflow: 'hidden',
//           }}>
//           {/* Header */}
//           <View
//             style={{
//               flexDirection: 'row',
//               alignItems: 'center',
//               justifyContent: 'space-between',
//               paddingHorizontal: 20,
//               paddingTop: 20,
//               paddingBottom: 12,
//               borderBottomWidth: 1,
//               borderBottomColor: theme.colors.surface2,
//             }}>
//             <View style={{flex: 1}}>
//               <Text style={[globalStyles.sectionTitle, {marginTop: 0}]}>
//                 RECREATE THIS LOOK
//               </Text>
//               {hasPieces && (
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 12,
//                     marginTop: 4,
//                   }}>
//                   {pieces.length} pieces identified • {totalProducts} products
//                   found
//                 </Text>
//               )}
//             </View>
//             <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
//               {/* Save Button */}
//               {hasPieces && (
//                 <TouchableOpacity
//                   onPress={handleSave}
//                   disabled={saving || saved}
//                   style={{
//                     backgroundColor: saved
//                       ? theme.colors.primary
//                       : theme.colors.surface2,
//                     borderRadius: 20,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     flexDirection: 'row',
//                     alignItems: 'center',
//                     opacity: saving ? 0.6 : 1,
//                   }}>
//                   {saving ? (
//                     <ActivityIndicator
//                       size="small"
//                       color={theme.colors.foreground}
//                     />
//                   ) : (
//                     <>
//                       <MaterialIcons
//                         name={saved ? 'check' : 'bookmark-outline'}
//                         size={18}
//                         color={
//                           saved
//                             ? theme.colors.background
//                             : theme.colors.foreground
//                         }
//                       />
//                       <Text
//                         style={{
//                           color: saved
//                             ? theme.colors.background
//                             : theme.colors.foreground,
//                           fontSize: 12,
//                           fontWeight: '600',
//                           marginLeft: 4,
//                         }}>
//                         {saved ? 'Saved' : 'Save'}
//                       </Text>
//                     </>
//                   )}
//                 </TouchableOpacity>
//               )}
//               {/* Close Button */}
//               <TouchableOpacity
//                 onPress={handleClose}
//                 style={{
//                   backgroundColor: theme.colors.foreground,
//                   borderRadius: 20,
//                   padding: 6,
//                 }}>
//                 <MaterialIcons
//                   name="close"
//                   size={20}
//                   color={theme.colors.background}
//                 />
//               </TouchableOpacity>
//             </View>
//           </View>

//           {/* Content */}
//           <ScrollView
//             showsVerticalScrollIndicator={false}
//             contentContainerStyle={{
//               paddingHorizontal: 20,
//               paddingTop: 16,
//               paddingBottom: 40,
//             }}>
//             {/* Source Image Preview */}
//             {source_image && (
//               <View style={{marginBottom: 24, alignItems: 'center'}}>
//                 <Image
//                   source={{uri: source_image}}
//                   style={{
//                     width: screenWidth * 0.35,
//                     height: screenWidth * 0.45,
//                     borderRadius: tokens.borderRadius.lg,
//                   }}
//                   resizeMode="cover"
//                 />
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 11,
//                     marginTop: 8,
//                     textAlign: 'center',
//                   }}>
//                   Your inspiration look
//                 </Text>
//               </View>
//             )}

//             {/* Pieces by Category */}
//             {hasPieces ? (
//               pieces.map((piece, idx) => (
//                 <PieceSection
//                   key={`piece-${idx}`}
//                   piece={piece}
//                   theme={theme}
//                   onShopPress={handleShopPress}
//                 />
//               ))
//             ) : isLegacyMode ? (
//               // Legacy flat grid for old results format
//               <>
//                 <Text
//                   style={{
//                     color: theme.colors.foreground,
//                     fontSize: 14,
//                     fontWeight: '600',
//                     marginBottom: 16,
//                   }}>
//                   {results.length} similar items found
//                 </Text>
//                 <View
//                   style={{
//                     flexDirection: 'row',
//                     flexWrap: 'wrap',
//                     justifyContent: 'space-between',
//                   }}>
//                   {results.map((item: any, idx: number) => (
//                     <ProductCard
//                       key={`result-${idx}`}
//                       item={item}
//                       theme={theme}
//                       onPress={handleShopPress}
//                     />
//                   ))}
//                 </View>
//               </>
//             ) : (
//               <View style={{alignItems: 'center', paddingTop: 40}}>
//                 <MaterialIcons
//                   name="search-off"
//                   size={48}
//                   color={theme.colors.muted}
//                 />
//                 <Text
//                   style={{
//                     color: theme.colors.muted,
//                     fontSize: 14,
//                     marginTop: 12,
//                     textAlign: 'center',
//                   }}>
//                   No outfit pieces identified.{'\n'}Try a different image.
//                 </Text>
//               </View>
//             )}
//           </ScrollView>
//         </View>
//       </View>

//       {/* Shop Overlay WebView */}
//       <IntegratedShopOverlay
//         visible={!!shopUrl}
//         url={shopUrl}
//         onClose={() => setShopUrl(null)}
//       />
//     </Modal>
//   );
// }
