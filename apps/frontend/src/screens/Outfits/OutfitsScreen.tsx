import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';
import AppleTouchFeedback from '../../components/AppleTouchFeedback/AppleTouchFeedback';
import {tokens} from '../../styles/tokens/tokens';

type Props = {
  navigate: (screen: string, params?: any) => void;
};

const OutfitsScreen = ({navigate}: Props) => {
  const {theme} = useAppTheme();

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      marginTop: 40
    },
    content: {
      flex: 1,
      paddingHorizontal: tokens.spacing.lg,
      paddingTop: tokens.spacing.xl,
    },
    heading: {
      fontSize: tokens.fontSize['2xl'],
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: tokens.spacing.xl,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xl,
      padding: tokens.spacing.lg,
      marginBottom: tokens.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: tokens.spacing.md,
    },
    iconContainer: {
      width: 48,
      height: 48,
      borderRadius: tokens.borderRadius.md,
      backgroundColor: theme.colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardTextContainer: {
      flex: 1,
    },
    cardTitle: {
      fontSize: tokens.fontSize.lg,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    cardSubtitle: {
      fontSize: tokens.fontSize.sm,
      color: theme.colors.muted,
      marginTop: tokens.spacing.quark,
    },
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        <Text style={styles.heading}>Outfit Builder</Text>

        <AppleTouchFeedback
          hapticStyle="impactLight"
          onPress={() => navigate('Outfit')}>
          <View style={styles.card}>
            <View style={styles.iconContainer}>
              <Icon
                name="dashboard-customize"
                size={24}
                color={theme.colors.button1}
              />
            </View>
            <View style={styles.cardTextContainer}>
              <Text style={styles.cardTitle}>AI Outfit Studio</Text>
              <Text style={styles.cardSubtitle}>
                Let Styla AI generate outfits based on your style, prompts or mood
              </Text>
            </View>
            <Icon name="chevron-right" size={24} color={theme.colors.muted} />
          </View>
        </AppleTouchFeedback>
        

        <AppleTouchFeedback
          hapticStyle="impactLight"
          onPress={() => navigate('OutfitCanvas')}>
          <View style={styles.card}>
            <View style={styles.iconContainer}>
              <Icon
                name="dashboard-customize"
                size={24}
                color={theme.colors.button1}
              />
            </View>
            <View style={styles.cardTextContainer}>
              <Text style={styles.cardTitle}>Manually Build Outfit</Text>
              <Text style={styles.cardSubtitle}>
                Drag and drop items from your wardrobe to build the perfect customized outfit
              </Text>
            </View>
            <Icon name="chevron-right" size={24} color={theme.colors.muted} />
          </View>
        </AppleTouchFeedback>

      </View>
    </SafeAreaView>
  );
};

export default OutfitsScreen;
