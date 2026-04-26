/* eslint-disable react-native/no-inline-styles */
import React from 'react';
import {Modal, View, TouchableOpacity} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {WebView} from 'react-native-webview';
import {
  SECURE_WEBVIEW_DEFAULTS,
  createOnShouldStartLoadWithRequest,
} from '../../config/webViewDefaults';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

type IntegratedShopOverlayProps = {
  visible: boolean;
  onClose: () => void;
  url: string | null;
};

export default function IntegratedShopOverlay({
  visible,
  onClose,
  url,
}: IntegratedShopOverlayProps) {
  const {theme} = useAppTheme();
  if (!visible || !url) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen">
      <SafeAreaView style={{flex: 1, backgroundColor: theme.colors.surface}}>
        {/* Close Button */}
        <TouchableOpacity
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 72,
            right: 18,
            zIndex: 999,
            backgroundColor: theme.colors.foreground,
            borderRadius: 24,
            borderColor: theme.colors.background,
            borderWidth: theme.borderWidth.hairline,
            padding: 6,
          }}>
          <MaterialIcons
            name="close"
            size={22}
            color={theme.colors.background}
          />
        </TouchableOpacity>

        {/* WebView */}
        {/* SECURITY: Uses SECURE_WEBVIEW_DEFAULTS to block dangerous schemes */}
        <WebView
          {...SECURE_WEBVIEW_DEFAULTS}
          originWhitelist={['https://*', 'http://*']}
          onShouldStartLoadWithRequest={createOnShouldStartLoadWithRequest({
            allowHttp: true,
          })}
          source={{uri: url}}
          startInLoadingState
          style={{flex: 1}}
        />
      </SafeAreaView>
    </Modal>
  );
}
