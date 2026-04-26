import React, {useState, useCallback, useMemo, useRef} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Dimensions,
} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import ViewShot from 'react-native-view-shot';
import {useAppTheme} from '../context/ThemeContext';
import {useUUID} from '../context/UUIDContext';
import {API_BASE_URL} from '../config/api';
import {getAccessToken} from '../utils/auth';
import OutfitCanvas from '../components/OutfitCanvas/OutfitCanvas';
import ItemDrawer from '../components/OutfitCanvas/ItemDrawer';
import SaveOutfitModal from '../components/OutfitCanvas/SaveOutfitModal';
import DiscardConfirmModal from '../components/OutfitCanvas/DiscardConfirmModal';
import ImportOutfitModal from '../components/OutfitCanvas/ImportOutfitModal';
import {CanvasItemData} from '../components/OutfitCanvas/CanvasItem';
import {SavedOutfitData} from '../hooks/useOutfitsData';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import uuid from 'react-native-uuid';

const {width: SCREEN_WIDTH} = Dimensions.get('window');

type WardrobeItem = {
  id: string;
  image?: string;
  image_url?: string;
  thumbnailUrl?: string;
  processedImageUrl?: string;
  touchedUpImageUrl?: string;
  name?: string;
  main_category?: string;
  mainCategory?: string;
};

type Props = {
  navigate: (screen: string, params?: any) => void;
  initialItem?: WardrobeItem;
};

export default function OutfitCanvasScreen({navigate, initialItem}: Props) {
  const {theme} = useAppTheme();
  const userId = useUUID();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const canvasRef = useRef<ViewShot>(null);

  // Get best image URL from wardrobe item
  // Backend computes 'image' with priority: touchedUp > processed > original
  const getItemImageUrl = (item: WardrobeItem): string => {
    return (
      item.image ||
      item.touchedUpImageUrl ||
      item.processedImageUrl ||
      item.thumbnailUrl ||
      item.image_url ||
      ''
    );
  };

  // Canvas state
  const [placedItems, setPlacedItems] = useState<CanvasItemData[]>(() => {
    // Initialize with initial item if provided
    if (initialItem) {
      const imageUrl = getItemImageUrl(initialItem);
      return [
        {
          id: uuid.v4() as string,
          wardrobeItemId: initialItem.id,
          imageUrl: resolveImageUrl(imageUrl),
          x: 0.5,
          y: 0.4,
          scale: 1.0,
          zIndex: 1,
        },
      ];
    }
    return [];
  });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [nextZIndex, setNextZIndex] = useState(2);
  const [isDirty, setIsDirty] = useState(false);

  // Grid overlay state
  const [showGrid, setShowGrid] = useState(false);

  // Modal state
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Resolve image URL helper
  function resolveImageUrl(u: string): string {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    const base = API_BASE_URL.replace(/\/+$/, '');
    const path = u.replace(/^\/+/, '');
    return `${base}/${path}`;
  }

  // Capture and upload canvas snapshot
  const captureAndUploadSnapshot = async (): Promise<string | null> => {
    try {
      if (!canvasRef.current?.capture) {
        console.log('Snapshot ref not available for capture');
        return null;
      }

      // Capture the tightly-cropped snapshot
      const uri = await canvasRef.current.capture();
      if (!uri) {
        console.log('Failed to capture canvas');
        return null;
      }

      const accessToken = await getAccessToken();
      const filename = `outfit-snapshot-${Date.now()}.png`;

      // Get presigned URL for upload
      const presignRes = await fetch(
        `${API_BASE_URL}/upload/presign?filename=${encodeURIComponent(filename)}&contentType=image/png`,
        {
          headers: {Authorization: `Bearer ${accessToken}`},
        },
      );

      if (!presignRes.ok) {
        console.error('Failed to get presigned URL');
        return null;
      }

      const {uploadUrl, publicUrl} = await presignRes.json();

      // Read the captured image as blob
      const response = await fetch(uri);
      const blob = await response.blob();

      // Upload to GCS using presigned URL
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {'Content-Type': 'image/png'},
        body: blob,
      });

      if (!uploadRes.ok) {
        console.error('Failed to upload snapshot to GCS');
        return null;
      }

      console.log('Canvas snapshot uploaded:', publicUrl);
      return publicUrl;
    } catch (error) {
      console.error('Error capturing/uploading snapshot:', error);
      return null;
    }
  };

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (payload: {name: string}) => {
      const accessToken = await getAccessToken();

      // Deselect item before capturing to hide blue border
      setSelectedItemId(null);
      // Wait for UI to update
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture canvas snapshot
      const snapshotUrl = await captureAndUploadSnapshot();

      // Build canvas_data for API
      const canvasData = {
        version: 1,
        placedItems: placedItems.map(item => ({
          id: item.id,
          wardrobeItemId: item.wardrobeItemId,
          x: item.x,
          y: item.y,
          scale: item.scale,
          zIndex: item.zIndex,
        })),
      };

      const res = await fetch(`${API_BASE_URL}/custom-outfits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          user_id: userId,
          name: payload.name,
          canvas_data: canvasData,
          // Use snapshot URL if available, otherwise fall back to first item image
          thumbnail_url: snapshotUrl || placedItems[0]?.imageUrl || '',
        }),
      });

      if (!res.ok) throw new Error('Failed to save outfit');
      return res.json();
    },
    onSuccess: async newOutfit => {
      // Auto-favorite the new outfit
      const accessToken = await getAccessToken();
      await fetch(`${API_BASE_URL}/outfit/favorite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({user_id: userId, outfit_id: newOutfit.outfit?.id || newOutfit.id, outfit_type: 'custom'}),
      }).catch(() => {});

      // Invalidate caches
      queryClient.invalidateQueries({queryKey: ['saved-outfits', userId]});
      queryClient.invalidateQueries({queryKey: ['savedOutfits', userId]});
      queryClient.invalidateQueries({queryKey: ['favorites', userId]});

      ReactNativeHapticFeedback.trigger('notificationSuccess', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });

      setShowSaveModal(false);
      setIsDirty(false);
      navigate('SavedOutfits');
    },
    onError: error => {
      console.error('Failed to save outfit:', error);
      ReactNativeHapticFeedback.trigger('notificationError', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });
    },
  });

  // Get placed wardrobe item IDs for drawer
  const placedItemIds = useMemo(
    () => placedItems.map(item => item.wardrobeItemId),
    [placedItems],
  );

  // Add item to canvas
  const handleAddItem = useCallback(
    (wardrobeItem: WardrobeItem) => {
      const imageUrl = getItemImageUrl(wardrobeItem);
      const newItem: CanvasItemData = {
        id: uuid.v4() as string,
        wardrobeItemId: wardrobeItem.id,
        imageUrl: resolveImageUrl(imageUrl),
        x: 0.5,
        y: 0.4,
        scale: 1.0,
        zIndex: nextZIndex,
      };

      setPlacedItems(prev => [...prev, newItem]);
      setNextZIndex(prev => prev + 1);
      setSelectedItemId(newItem.id);
      setIsDirty(true);
    },
    [nextZIndex],
  );

  // Update item position/scale
  const handleUpdateItem = useCallback(
    (id: string, updates: Partial<CanvasItemData>) => {
      setPlacedItems(prev =>
        prev.map(item => (item.id === id ? {...item, ...updates} : item)),
      );
      setIsDirty(true);
    },
    [],
  );

  // Bring item to front
  const handleBringToFront = useCallback(
    (id: string) => {
      setPlacedItems(prev =>
        prev.map(item =>
          item.id === id ? {...item, zIndex: nextZIndex} : item,
        ),
      );
      setNextZIndex(prev => prev + 1);
      setIsDirty(true);
    },
    [nextZIndex],
  );

  // Send item to back
  const handleSendToBack = useCallback((id: string) => {
    setPlacedItems(prev => {
      const minZ = Math.min(...prev.map(i => i.zIndex));
      return prev.map(item =>
        item.id === id ? {...item, zIndex: minZ - 1} : item,
      );
    });
    setIsDirty(true);
  }, []);

  // Remove item
  const handleRemoveItem = useCallback((id: string) => {
    setPlacedItems(prev => prev.filter(item => item.id !== id));
    setSelectedItemId(null);
    setIsDirty(true);
  }, []);

  // Handle back button
  const handleBack = useCallback(() => {
    if (isDirty && placedItems.length > 0) {
      setShowDiscardModal(true);
    } else {
      navigate('Outfits');
    }
  }, [isDirty, placedItems.length, navigate]);

  // Handle save button
  const handleSavePress = useCallback(() => {
    if (placedItems.length === 0) {
      ReactNativeHapticFeedback.trigger('notificationWarning', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });
      return;
    }
    setShowSaveModal(true);
  }, [placedItems.length]);

  // Handle clear canvas
  const handleClearCanvas = useCallback(() => {
    if (placedItems.length === 0) return;
    ReactNativeHapticFeedback.trigger('impactMedium', {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
    setPlacedItems([]);
    setSelectedItemId(null);
    setNextZIndex(1);
    setIsDirty(false);
  }, [placedItems.length]);

  // Handle save from modal
  const handleSave = useCallback(
    (name: string) => {
      saveMutation.mutate({name});
    },
    [saveMutation],
  );

  // Handle discard
  const handleDiscard = useCallback(() => {
    setShowDiscardModal(false);
    navigate('Wardrobe');
  }, [navigate]);

  // Handle save from discard modal
  const handleSaveFromDiscard = useCallback(() => {
    setShowDiscardModal(false);
    setShowSaveModal(true);
  }, []);

  // Handle import outfit from modal
  const handleImportOutfit = useCallback(
    (outfit: SavedOutfitData) => {
      setShowImportModal(false);

      // Get ALL items to import - use allItems if available, otherwise fallback
      const itemsToImport =
        outfit.allItems && outfit.allItems.length > 0
          ? outfit.allItems
          : [outfit.top, outfit.bottom, outfit.shoes].filter(
              item => item && item.id,
            );

      if (itemsToImport.length === 0) {
        ReactNativeHapticFeedback.trigger('notificationWarning', {
          enableVibrateFallback: true,
          ignoreAndroidSystemSettings: false,
        });
        return;
      }

      let currentZIndex = nextZIndex;
      const newItems: CanvasItemData[] = [];

      // Build position lookup map from canvas_data if available
      const canvasData = outfit.canvas_data?.placedItems;
      const positionMap = new Map<string, {x: number; y: number; scale: number}>();

      if (canvasData && canvasData.length > 0) {
        canvasData.forEach(p => {
          positionMap.set(p.wardrobeItemId, {
            x: p.x,
            y: p.y,
            scale: p.scale,
          });
        });
      }

      // Import each item exactly once
      itemsToImport.forEach((item, index) => {
        const savedPosition = positionMap.get(item.id);

        if (savedPosition) {
          // Use saved position from canvas_data
          newItems.push({
            id: uuid.v4() as string,
            wardrobeItemId: item.id,
            imageUrl: resolveImageUrl(item.image),
            x: savedPosition.x,
            y: savedPosition.y,
            scale: savedPosition.scale,
            zIndex: currentZIndex++,
          });
        } else {
          // Auto-layout: stack vertically with some spacing
          newItems.push({
            id: uuid.v4() as string,
            wardrobeItemId: item.id,
            imageUrl: resolveImageUrl(item.image),
            x: 0.5,
            y: 0.15 + index * 0.25,
            scale: 1.0,
            zIndex: currentZIndex++,
          });
        }
      });

      // Update state
      setPlacedItems(prev => [...prev, ...newItems]);
      setNextZIndex(prev => prev + newItems.length);
      setIsDirty(true);

      ReactNativeHapticFeedback.trigger('notificationSuccess', {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });
    },
    [nextZIndex],
  );

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
       marginTop: 50
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      // justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: insets.top > 0 ? 8 : 16,
      paddingBottom: 10,
      gap: 8,
      backgroundColor: theme.colors.background,
        //  backgroundColor: 'yellow',
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
    },
    importButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: theme.colors.button1,
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    saveButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: theme.colors.button1,
      marginRight: 8
    },
    saveButtonDisabled: {
      opacity: 0.4,
    },
    saveButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.buttonText1,
    },
    saveButtonTextDisabled: {
      // opacity: 0.6,
    },
    clearButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: theme.colors.error,
    },
    clearButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.buttonText1,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    canvasContainer: {
      flex: 1,
    },
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            activeOpacity={0.7}>
            <MaterialIcons
              name="arrow-back"
              size={24}
              color={theme.colors.foreground}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.importButton}
            onPress={() => setShowImportModal(true)}
            activeOpacity={0.7}>
          <Text
            style={[
              styles.saveButtonText,
              placedItems.length === 0 && styles.saveButtonTextDisabled,
            ]}>
            Import
          </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[
              styles.saveButton,
              placedItems.length === 0 && styles.saveButtonDisabled,
            ]}
            onPress={handleSavePress}
            activeOpacity={0.7}
            disabled={placedItems.length === 0}>
            <Text
              style={[
                styles.saveButtonText,
                placedItems.length === 0 && styles.saveButtonTextDisabled,
              ]}>
              Save
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.clearButton}
            onPress={handleClearCanvas}
            activeOpacity={0.7}
            disabled={placedItems.length === 0}>
            <Text
              style={[
                styles.clearButtonText,
                placedItems.length === 0 && styles.saveButtonTextDisabled,
              ]}>
              Clear
            </Text>
          </TouchableOpacity>

        </View>
      </View>

      {/* Canvas */}
      <View style={styles.canvasContainer}>
        <ViewShot
          ref={canvasRef}
          options={{format: 'png', quality: 0.9}}
          style={{flex: 1}}>
          <OutfitCanvas
            placedItems={placedItems}
            selectedItemId={selectedItemId}
            showGrid={showGrid}
            onSelectItem={setSelectedItemId}
            onDeselectItem={() => setSelectedItemId(null)}
            onUpdateItem={handleUpdateItem}
            onBringToFront={handleBringToFront}
            onSendToBack={handleSendToBack}
            onRemoveItem={handleRemoveItem}
          />
        </ViewShot>

        {/* Grid toggle — outside ViewShot so it won't appear in snapshots */}
        <TouchableOpacity
          onPress={() => setShowGrid(prev => !prev)}
          activeOpacity={0.7}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 9999,
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: showGrid ? `${theme.colors.background}` : `${theme.colors.muted}CC`,
            justifyContent: 'center',
            alignItems: 'center',
          }}>
          <MaterialIcons
            name="grid-on"
            size={18}
            color={showGrid ? theme.colors.primary : theme.colors.foreground}
          />
        </TouchableOpacity>
      </View>

      {/* Item Drawer */}
      <ItemDrawer onAddItem={handleAddItem} placedItemIds={placedItemIds} />

      {/* Modals */}
      <SaveOutfitModal
        visible={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSave={handleSave}
        isSaving={saveMutation.isPending}
      />

      <DiscardConfirmModal
        visible={showDiscardModal}
        onClose={() => setShowDiscardModal(false)}
        onDiscard={handleDiscard}
        onSave={handleSaveFromDiscard}
      />

      <ImportOutfitModal
        visible={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSelectOutfit={handleImportOutfit}
      />
    </SafeAreaView>
  );
}
