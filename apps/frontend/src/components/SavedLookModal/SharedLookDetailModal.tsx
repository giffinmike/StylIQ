import React from 'react';
import {Modal, Pressable, Image, View, Text, Dimensions} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';

type Props = {
  visible: boolean;
  look: any | null;
  onClose: () => void;
};

export default function SharedLookDetailModal({visible, look, onClose}: Props) {
  const {theme} = useAppTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          justifyContent: 'center',
          alignItems: 'center',
        }}
        onPress={onClose}>
        {/* Close button */}
        <Pressable
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 70,
            right: 18,
            zIndex: 10,
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: 'white',
            borderColor: 'black',
            borderWidth: theme.borderWidth.hairline,
            justifyContent: 'center',
            alignItems: 'center',
          }}>
          <Icon name="close" size={20} color="black" />
        </Pressable>
        <Pressable
          onPress={e => e.stopPropagation()}
          style={{  
            overflow: 'hidden',
            width: '100%',
            maxWidth: 500,
          }}>
          {/* Image */}
          {look?.image_url ? (
            <Image
              source={{uri: look.image_url}}
              style={{
                width: '100%',
                height: Dimensions.get('window').height * 0.65,
                backgroundColor: theme.colors.imageBackground,
              }}
              resizeMode="contain"
            />
          ) : null}

          {/* Details */}
          <View style={{padding: 16}}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: '700',
                color: theme.colors.foreground,
              }}>
              {look?.name || look?.title || 'Shared Look'}
            </Text>
            {look?.description ? (
              <Text
                style={{
                  fontSize: 14,
                  color: theme.colors.foreground2,
                  marginTop: 6,
                }}>
                {look.description}
              </Text>
            ) : null}
            {look?.created_at ? (
              <Text
                style={{
                  fontSize: 12,
                  color: theme.colors.muted,
                  marginTop: 8,
                }}>
                {new Date(look.created_at).toLocaleDateString()}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
