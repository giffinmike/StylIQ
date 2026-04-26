/* eslint-disable react-native/no-inline-styles */
import React, {useRef, useLayoutEffect, useState, useCallback} from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Animated,
  Dimensions,
  PanResponder,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import * as Animatable from 'react-native-animatable';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {tokens} from '../../styles/tokens/tokens';
import {useAppTheme} from '../../context/ThemeContext';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';
import {useAnalyzeLook} from '../../hooks/useAnalyzeLook';
import {useRecreateLook} from '../../hooks/useRecreateLook';
import {useUUID} from '../../context/UUIDContext';
import {API_BASE_URL} from '../../config/api';
import {getAccessToken} from '../../utils/auth';
import {useSaveRecreatedLook, useSaveLookMemory} from '../../hooks/useHomeData';
import {useGlobalStyles} from '../../styles/useGlobalStyles';
import {moderateScale} from '../../utils/scale';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import SaveLookModal from '../SavedLookModal/SavedLookModal';
import {TooltipBubble} from '../ToolTip/ToolTip1';
import {FlashList} from '@shopify/flash-list';
import FastImage from 'react-native-fast-image';

const {height, width} = Dimensions.get('window');

export default function AllSavedLooksModal({
  visible,
  onClose,
  savedLooks,
  recreateLook,
  openShopModal,
  shopResults,
  openPersonalizedShopModal,
  openVisualRecreateModal,
  onSaveLook,
  onRecreate,
}: {
  visible: boolean;
  onClose: () => void;
  savedLooks: any[];
  recreateLook?: (params: {
    image_url: string;
    tags?: string[];
  }) => Promise<void> | void;
  openShopModal?: (tags?: string[]) => void;
  shopResults?: any[];
  openPersonalizedShopModal?: (data: {
    recreated_outfit?: any[];
    purchases?: any[];
    suggested_purchases?: any[];
    styleNote?: string;
    style_note?: string;
  }) => void;
  openVisualRecreateModal?: (data: {
    pieces?: any[];
    results?: any[];
    source_image?: string;
    lookId?: string;
    lookName?: string;
    tags?: string[];
  }) => void;
  onSaveLook?: () => void;
  onRecreate?: () => void;
}) {
  const uuidContext = useUUID();
  const userId =
    typeof uuidContext === 'string'
      ? uuidContext
      : (uuidContext as any)?.uuid || uuidContext;

  const {analyzeLook} = useAnalyzeLook();
  const translateY = useRef(new Animated.Value(0)).current;
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();

  const [loading, setLoading] = useState(false);
  const [shopLoading, setShopLoading] = useState(false);
  const [successState, setSuccessState] = useState<'recreate' | 'shop' | null>(
    null,
  );
  const [saveModalVisible, setSaveModalVisible] = useState(false);

  const insets = useSafeAreaInsets();

  const [personalizedMode, setPersonalizedMode] = useState(false);
  const {personalizedRecreate, loading: recreateLoading} = useRecreateLook();

  const saveRecreatedLookMutation = useSaveRecreatedLook();
  const saveLookMemoryMutation = useSaveLookMemory();

  const styles = StyleSheet.create({
    modalContainer: {
      flex: 1,
      backgroundColor: 'transparent',
      justifyContent: 'flex-start',
      alignItems: 'center',
      paddingTop: tokens.spacing.lg,
    },
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 1)',
    },
    panel: {
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 20,
      shadowOffset: {width: 0, height: -8},
      elevation: 12,
      maxWidth: '94%',
      alignSelf: 'center',
      paddingHorizontal: moderateScale(tokens.spacing.md1),
    },
    closeIcon: {
      position: 'absolute',
      top: 0,
      right: 18,
      zIndex: 20,
      backgroundColor: 'white',
      borderRadius: 20,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.muted,
      padding: 6,
    },
    gestureZone: {
      position: 'absolute',
      top: 0,
      height: 45,
      width: '100%',
      zIndex: 2,
      backgroundColor: 'transparent',
    },
  });

  useLayoutEffect(() => {
    if (visible) {
      translateY.setValue(0);
    }
  }, [visible, translateY]);

  const handleOnShow = () => {
    translateY.setValue(0);
  };

  const handleClose = () => {
    Animated.timing(translateY, {
      toValue: height,
      duration: 220,
      useNativeDriver: true,
    }).start(({finished}) => {
      if (finished) {
        onClose();
        setTimeout(() => {
          translateY.setValue(0);
        }, 100);
      }
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 8,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 100 || g.vy > 0.3) {
          handleClose();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  const handleRecreatePress = async (look: any) => {
    try {
      setLoading(true);

      if (personalizedMode) {
        console.log('💎 Personalized Recreate triggered →', look.image_url);

        const data = await personalizedRecreate({
          user_id: userId,
          image_url: look.image_url,
        });

        console.log('💎 Personalized result:', data);

        if (userId) {
          saveRecreatedLookMutation.mutate(
            {
              userId,
              source_image_url: look.image_url,
              generated_outfit: data,
              tags: look.tags || [],
            },
            {
              onError: saveErr => {
                console.error('Failed to save recreated look:', saveErr);
              },
            },
          );
        }

        setSuccessState('recreate');
        ReactNativeHapticFeedback.trigger('impactLight');

        if (openPersonalizedShopModal) {
          openPersonalizedShopModal({
            recreated_outfit: data?.recreated_outfit ?? [],
            suggested_purchases: data?.suggested_purchases ?? [],
            style_note: data?.style_note ?? '',
          });
        } else {
          console.warn('⚠️ No personalized shop modal handler provided.');
        }

        onRecreate?.();
        onClose();
        setTimeout(() => setSuccessState(null), 1200);
        return;
      }

      // console.log('👗 Outfit Recreate triggered');
      // console.log('👗 Look object:', JSON.stringify(look, null, 2));
      // console.log('👗 Image URL being sent:', look.image_url);
      ReactNativeHapticFeedback.trigger('impactLight');

      if (!look.image_url) {
        console.error('❌ No image_url found in look object!');
        throw new Error('No image URL available for this saved look');
      }

      // console.log('👗 Calling API:', `${API_BASE_URL}/ai/recreate-outfit`);
      const accessToken = await getAccessToken();
      const response = await fetch(`${API_BASE_URL}/ai/recreate-outfit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({imageUrl: look.image_url}),
      });

      // console.log('👗 Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ API Error:', errorText);
        throw new Error(
          `Outfit recreate failed (${response.status}): ${errorText}`,
        );
      }

      const data = await response.json();
      // console.log('👗 Outfit recreate result:', data);
      // console.log('👗 Found', data?.pieces?.length, 'outfit pieces');

      setSuccessState('recreate');

      if (openVisualRecreateModal) {
        openVisualRecreateModal({
          pieces: data.pieces || [],
          source_image: look.image_url,
          lookName: look.name,
          tags: look.tags || [],
        });
      } else {
        console.warn('⚠️ No visual recreate modal handler provided.');
      }

      onClose();
      setTimeout(() => setSuccessState(null), 1200);
    } catch (e: any) {
      console.error(
        '[AllSavedLooksModal] recreateLook failed:',
        e?.message || e,
      );
      if (openVisualRecreateModal) {
        openVisualRecreateModal({
          results: [],
          source_image: look.image_url,
        });
        onClose();
      }
    } finally {
      // console.log('✅ [handleRecreatePress] Loading cleared');
      setLoading(false);
    }
  };

  const handleShopPress = async (look: any) => {
    if (!openShopModal && !openPersonalizedShopModal) return;

    try {
      setShopLoading(true);
      console.log('🟢 [ShopPress] START — image:', look.image_url);

      if (personalizedMode) {
        console.log(
          '🟡 [ShopPress] Personalized mode selected — ignored for Shop flow.',
        );
      }

      const analysis = await analyzeLook(look.image_url);
      const aiTags = analysis?.tags || [];
      console.log('🧠 [ShopPress] AI tags:', aiTags);

      const words: string[] = [];
      if (look.gender || look.gender_presentation)
        words.push((look.gender || look.gender_presentation).toLowerCase());
      else words.push('men');

      if (Array.isArray(aiTags))
        words.push(...aiTags.map(t => t.toLowerCase()));
      if (look.mainCategory) words.push(look.mainCategory.toLowerCase());
      if (look.subCategory) words.push(look.subCategory.toLowerCase());
      if (look.style_type) words.push(look.style_type.toLowerCase());
      if (look.occasion) words.push(look.occasion.toLowerCase());
      if (look.seasonality) words.push(look.seasonality.toLowerCase());
      if (look.pattern) words.push(look.pattern.toLowerCase());
      if (look.color) words.push(look.color.toLowerCase());
      if (look.fit) words.push(look.fit.toLowerCase());

      if (Array.isArray(look.tags)) {
        for (const tag of look.tags) {
          if (
            tag &&
            !['outfit', 'style', 'fashion', 'clothing'].includes(
              tag.toLowerCase(),
            )
          ) {
            words.push(tag.toLowerCase());
          }
        }
      }

      const weighted = words.flatMap(t => {
        const x = t.toLowerCase();
        if (/(flannel|denim|linen|corduroy)/.test(x)) return [x, x, x];
        if (/(plaid|striped|solid|check)/.test(x)) return [x, x];
        if (/(relaxed|tailored|oversized)/.test(x)) return [x, x];
        if (/(autumn|winter|layered)/.test(x)) return [x, x];
        return [x];
      });

      const unique = Array.from(new Set(weighted)).filter(Boolean);
      const query = unique.join(' ').trim();
      console.log('🧩 [ShopPress] Final query:', query);

      console.log('💾 [LookMemory] userId:', userId);

      if (userId) {
        saveLookMemoryMutation.mutate(
          {
            userId,
            image_url: look.image_url,
            ai_tags: unique,
            query_used: query,
          },
          {
            onSuccess: () => {
              console.log('💾 [LookMemory] Saved successfully');
            },
            onError: err => {
              console.error('💾 [LookMemory] Save failed:', err);
            },
          },
        );
      } else {
        console.warn('[LookMemory] No UUID found — skipping look memory save.');
      }

      setSuccessState('shop');
      setTimeout(() => setSuccessState(null), 1200);
      setTimeout(async () => {
        onClose();
        await openShopModal?.([query]);
        setShopLoading(false);
      }, 500);
    } catch (err) {
      console.error('❌ [ShopPress] Error:', err);
    } finally {
      setShopLoading(false);
    }
  };

  const numColumns = 2;
  const itemWidth = (width - moderateScale(tokens.spacing.md1) * 2 - 4) / 2;

  const keyExtractor = useCallback(
    (item: any, index: number) => item.id?.toString() || `look-${index}`,
    [],
  );

  const renderItem = useCallback(
    ({item: look}: {item: any}) => {
      // Use || to treat empty strings as falsy
      const imageUri =
        look.thumbnailUrl || look.image_url || look.image || null;

      return (
        <View
          style={{
            width: itemWidth,
            marginBottom: tokens.spacing.nano,
            marginHorizontal: 1,
            overflow: 'hidden',
             borderRadius: tokens.borderRadius.switch1
          }}>
          <View
            style={{
              width: '100%',
              aspectRatio: 3 / 4,
            }}>
            {imageUri ? (
              <FastImage
                source={{
                  uri: imageUri,
                  priority: FastImage.priority.normal,
                  cache: FastImage.cacheControl.immutable,
                }}
                style={{width: '99%', height: '100%'}}
                resizeMode={FastImage.resizeMode.cover}
              />
            ) : (
              <View
                style={{
                  width: '100%',
                  height: '100%',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}>
                <MaterialIcons
                  name="image"
                  size={32}
                  color={theme.colors.muted}
                />
              </View>
            )}

            <TouchableOpacity
              activeOpacity={0.8}
              onPressIn={() =>
                ReactNativeHapticFeedback.trigger('impactLight', {
                  enableVibrateFallback: true,
                  ignoreAndroidSystemSettings: false,
                })
              }
              onPress={() => handleRecreatePress(look)}
              disabled={loading}
              style={{
                position: 'absolute',
                bottom: 12,
                left: 8,
                right: 8,
                backgroundColor: 'rgba(0, 0, 0, 0.77)',
                borderRadius: tokens.borderRadius.sm,
                // borderColor: theme.colors.input,
                // borderWidth: tokens.borderWidth.hairline,
                paddingVertical: 10,
                opacity: loading ? 0.6 : 1,
              }}>
              <Text
                style={{
                  textAlign: 'center',
                  color: '#fff',
                  fontWeight: '500',
                  fontSize: 12,
                }}>
                Recreate Style
              </Text>
            </TouchableOpacity>
          </View>

          {look.tags?.length > 0 && (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
              }}>
              {look.tags.slice(0, 2).map((t: string, i: number) => (
                <View
                  key={`${t}-${i}`}
                  style={{
                    paddingVertical: 3,
                    margin: 3,
                  }}>
                  <Text
                    style={{
                      fontSize: 11,
                    }}>
                    #{t}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <Text
            style={{
             paddingTop: 6,
              color: theme.colors.foreground,
              fontWeight: '600',
              fontSize: 12,
              marginBottom: 10,
               textTransform: 'uppercase'
            }}
            numberOfLines={1}>
            {look.name || 'Unnamed Look'}
          </Text>
        </View>
      );
    },
    [theme, loading, itemWidth, handleRecreatePress],
  );

  const ListEmptyComponent = useCallback(
    () => (
      <View
        style={{
          width: '100%',
          alignItems: 'center',
          paddingTop: tokens.spacing.xl,
        }}>
        <Text style={globalStyles.missingDataMessage1}>No Saved Images</Text>
        <View style={{marginTop: tokens.spacing.sm}}>
          <TooltipBubble
            message="Tap the Add Image button above to save your favorite looks."
            position="bottom"
          />
        </View>
      </View>
    ),
    [globalStyles],
  );

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      presentationStyle="overFullScreen"
      onRequestClose={handleClose}
      onShow={handleOnShow}>
      <View style={styles.modalContainer} pointerEvents="box-none">
        <View style={styles.backdrop} />
        <View
          style={{
            height: insets.top - 25,
            backgroundColor: theme.colors.background,
          }}
        />
        <Animated.View
          style={[
            styles.panel,
            {
              transform: [{translateY}],
              width: '100%',
              maxWidth: '100%',
              height: '97%',
              alignSelf: 'center',
              borderRadius: tokens.borderRadius['2xl'],
              overflow: 'hidden',
              backgroundColor: theme.colors.background,
              paddingBottom: 16,
            },
          ]}
          pointerEvents="box-none">
          <TouchableOpacity
            style={[styles.closeIcon, {marginTop: 10}]}
            onPress={() => {
              // ReactNativeHapticFeedback.trigger('impactLight');
              handleClose();
            }}
            hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
            <MaterialIcons name="close" size={22} color={'black'} />
          </TouchableOpacity>

          <View
            {...panResponder.panHandlers}
            onStartShouldSetResponder={() => true}
            pointerEvents="box-only"
            style={styles.gestureZone}
          />

          <View
            style={{
              paddingVertical: 10,
              borderBottomColor: 'rgba(255,255,255,0.08)',
              borderBottomWidth: StyleSheet.hairlineWidth,
              flexDirection: 'column',
              alignItems: 'flex-start',
              justifyContent: 'center',
            }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                marginBottom: 6,
              }}>
              <Text
                numberOfLines={1}
                style={[
                  globalStyles.sectionTitle,
                  {
                    flexShrink: 1,
                    flexGrow: 1,
                    minWidth: 0,
                    marginRight: 8,
                    marginTop: 4,
                  },
                ]}>
                SAVED INPSIRING STYLES
              </Text>
            </View>

            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'flex-start',
                width: '100%',
              }}>
              <AppleTouchFeedback
                style={[
                  globalStyles.buttonPrimary4,
                  {width: 100, backgroundColor: theme.colors.button1},
                ]}
                hapticStyle="impactLight"
                onPress={() => setSaveModalVisible(true)}>
                <Text
                  style={
                    (globalStyles.buttonPrimaryText4,
                    {
                      color: theme.colors.buttonText1,
                      fontWeight: 700,
                      fontSize: 12,
                    })
                  }>
                  Add Image
                </Text>
              </AppleTouchFeedback>
            </View>
          </View>

          <Animatable.View animation="fadeIn" duration={400} style={{flex: 1}}>
            <FlashList
              data={savedLooks}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              numColumns={numColumns}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                paddingBottom: insets.bottom + 120,
              }}
              ListEmptyComponent={ListEmptyComponent}
            />
          </Animatable.View>

          {(loading || shopLoading) && (
            <Animatable.View
              animation="fadeIn"
              duration={250}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.5)',
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 999,
              }}>
              <Animatable.View
                animation="pulse"
                easing="ease-in-out"
                iterationCount="infinite"
                duration={1000}
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  borderWidth: 3,
                  borderColor: theme.colors.buttonText1,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}>
                <ActivityIndicator
                  size="small"
                  color={theme.colors.buttonText1}
                />
              </Animatable.View>

              <Text
                style={{
                  color: theme.colors.buttonText1,
                  fontWeight: '600',
                  fontSize: 15,
                  marginTop: 20,
                }}>
                {loading
                  ? 'Recreating the style. Hang tight...'
                  : 'Shopping the style. Hang tight...'}
              </Text>
            </Animatable.View>
          )}
        </Animated.View>
      </View>

      <SaveLookModal
        visible={saveModalVisible}
        onClose={() => setSaveModalVisible(false)}
        onSave={onSaveLook}
      />
    </Modal>
  );
}
