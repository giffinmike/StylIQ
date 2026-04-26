import React, {useState, useCallback} from 'react';
import {StyleSheet, LayoutChangeEvent, Pressable, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {useAppTheme} from '../../context/ThemeContext';
import CanvasItem, {CanvasItemData} from './CanvasItem';
import ItemContextMenu from './ItemContextMenu';

type Props = {
  placedItems: CanvasItemData[];
  selectedItemId: string | null;
  showGrid?: boolean;
  onSelectItem: (id: string) => void;
  onDeselectItem: () => void;
  onUpdateItem: (id: string, updates: Partial<CanvasItemData>) => void;
  onBringToFront: (id: string) => void;
  onSendToBack: (id: string) => void;
  onRemoveItem: (id: string) => void;
};

export default function OutfitCanvas({
  placedItems,
  selectedItemId,
  showGrid = false,
  onSelectItem,
  onDeselectItem,
  onUpdateItem,
  onBringToFront,
  onSendToBack,
  onRemoveItem,
}: Props) {
  const {theme} = useAppTheme();
  const [canvasDimensions, setCanvasDimensions] = useState({
    width: 0,
    height: 0,
  });
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [contextMenuItemId, setContextMenuItemId] = useState<string | null>(
    null,
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const {width, height} = event.nativeEvent.layout;
    setCanvasDimensions({width, height});
  }, []);

  const handlePositionChange = useCallback(
    (id: string, x: number, y: number) => {
      onUpdateItem(id, {x, y});
    },
    [onUpdateItem],
  );

  const handleScaleChange = useCallback(
    (id: string, scale: number) => {
      onUpdateItem(id, {scale});
    },
    [onUpdateItem],
  );

  const handleLongPress = useCallback((id: string) => {
    setContextMenuItemId(id);
    setContextMenuVisible(true);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuVisible(false);
    setContextMenuItemId(null);
  }, []);

  const handleContextBringToFront = useCallback(() => {
    if (contextMenuItemId) {
      onBringToFront(contextMenuItemId);
    }
  }, [contextMenuItemId, onBringToFront]);

  const handleContextSendToBack = useCallback(() => {
    if (contextMenuItemId) {
      onSendToBack(contextMenuItemId);
    }
  }, [contextMenuItemId, onSendToBack]);

  const handleContextRemove = useCallback(() => {
    if (contextMenuItemId) {
      onRemoveItem(contextMenuItemId);
    }
  }, [contextMenuItemId, onRemoveItem]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
       backgroundColor: theme.colors.imageBackground
    },
    canvas: {
      flex: 1,
      position: 'relative',
    },
  });

  // Sort items by zIndex for proper layering
  const sortedItems = [...placedItems].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <GestureHandlerRootView style={styles.container}>
      <Pressable style={styles.canvas} onLayout={handleLayout} onPress={onDeselectItem}>
        {canvasDimensions.width > 0 &&
          canvasDimensions.height > 0 &&
          sortedItems.map(item => (
            <CanvasItem
              key={item.id}
              item={item}
              canvasWidth={canvasDimensions.width}
              canvasHeight={canvasDimensions.height}
              isSelected={selectedItemId === item.id}
              onSelect={() => onSelectItem(item.id)}
              onPositionChange={(x, y) => handlePositionChange(item.id, x, y)}
              onScaleChange={scale => handleScaleChange(item.id, scale)}
              onBringToFront={() => onBringToFront(item.id)}
              onLongPress={() => handleLongPress(item.id)}
            />
          ))}

        {showGrid && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={{position: 'absolute', left: '33.333%', top: 0, width: 1, height: '100%', backgroundColor: `${theme.colors.background}1A`}} />
            <View style={{position: 'absolute', left: '66.666%', top: 0, width: 1, height: '100%', backgroundColor: `${theme.colors.background}1A`}} />
            <View style={{position: 'absolute', top: '33.333%', left: 0, height: 1, width: '100%', backgroundColor: `${theme.colors.background}1A`}} />
            <View style={{position: 'absolute', top: '66.666%', left: 0, height: 1, width: '100%', backgroundColor: `${theme.colors.background}1A`}} />
          </View>
        )}

      </Pressable>

      <ItemContextMenu
        visible={contextMenuVisible}
        onClose={handleCloseContextMenu}
        onBringToFront={handleContextBringToFront}
        onSendToBack={handleContextSendToBack}
        onRemove={handleContextRemove}
      />
    </GestureHandlerRootView>
  );
}
