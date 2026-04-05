// // screens/OnboardingScreen.tsx
import React, {useRef, useState, useEffect, useMemo} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Dimensions,
  FlatList,
  Animated,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  TouchableWithoutFeedback,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import * as Animatable from 'react-native-animatable';
import {Picker} from '@react-native-picker/picker';
import {useAppTheme} from '../context/ThemeContext';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAuth0} from 'react-native-auth0';
import {useUUID} from '../context/UUIDContext';
import {API_BASE_URL} from '../config/api';
import {getAccessToken} from '../utils/auth';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {getData} from 'country-list';
import {Chip} from '../components/Chip/Chip';
import {useShoppingStore} from '../../../../store/shoppingStore';

type Props = {navigate: (screen: string, params?: any) => void};

const {width} = Dimensions.get('window');
const ONBOARDING_KEY = 'stylhelpr_onboarding_complete';

export default function OnboardingScreen({navigate}: Props) {
  const {theme, setSkin} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const {user} = useAuth0();
  const userId = useUUID();
  const quickShopSites = useShoppingStore(s => s.quickShopSites);
  const presetBrandNames = useMemo(() => quickShopSites.map(s => s.name), [quickShopSites]);

  // -----------------------------------------------------
  // STYLES
  // -----------------------------------------------------
  const styles = StyleSheet.create({
    panel: {
      width,
      padding: 24,
      alignItems: 'center',
      justifyContent: 'flex-start',
    },

    stepImage: {
      width: width * 0.75,
      height: width * 0.75,
      borderRadius: 20,
      marginBottom: 40,
    },

    stepTitle: {
      fontSize: 28,
      fontWeight: '700',
    },

    stepDescription: {
      fontSize: 17,
      textAlign: 'center',
      opacity: 0.7,
      paddingHorizontal: 20,
      marginTop: 20,
    },

    formContainer: {
      width,
    },
    card: {
      padding: 20,
      borderRadius: 20,
      margin: 6,
      marginTop: 90,
    },
    title: {
      fontSize: 36,
      fontWeight: '600',
      marginBottom: 22,
      textAlign: 'center',
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      marginBottom: 8,
      textTransform: 'capitalize',
      color: theme.colors.foreground,
    },
    input: {
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 14,
      marginBottom: 22,
      fontSize: 15,
      color: theme.colors.foreground,
    },
    selectorButton: {
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 16,
      marginBottom: 22,
      borderWidth: 1,
    },
    selectorText: {
      fontSize: 15,
    },
    modalRoot: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    backdropHitArea: {flex: 1},
    sheet: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: 24,
    },
    sheetToolbar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      padding: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    button: {
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 20,
    },
    buttonText: {
      fontSize: 16,
      fontWeight: '600',
    },

    dotsContainer: {
      position: 'absolute',
      bottom: 105,
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'center',
    },
    dot: {
      height: 8,
      marginHorizontal: 5,
      borderRadius: 4,
    },
    // New onboarding styles
    onboardingContainer: {
      width,
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    onboardingHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 60,
      paddingBottom: 10,
    },
    backButton: {
      padding: 8,
    },
    backButtonText: {
      fontSize: 28,
      color: theme.colors.foreground,
    },
    skipButton: {
      padding: 8,
    },
    skipButtonText: {
      fontSize: 16,
      color: theme.colors.muted,
    },
    progressBarContainer: {
      height: 4,
      backgroundColor: theme.colors.surface3,
      marginHorizontal: 20,
      borderRadius: 2,
      marginBottom: 20,
    },
    progressBar: {
      height: 4,
      backgroundColor: theme.colors.button1,
      borderRadius: 2,
    },
    onboardingContent: {
      flex: 1,
      paddingHorizontal: 24,
    },
    onboardingTitle: {
      fontSize: 26,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: 24,
    },
    onboardingTitleCentered: {
      fontSize: 26,
      fontWeight: '700',
      color: theme.colors.foreground,
      textAlign: 'center',
      marginTop: 40,
    },
    mascotImage: {
      width: 180,
      height: 180,
      alignSelf: 'center',
      marginTop: 40,
      marginBottom: 20,
      backgroundColor: 'transparent',
    },
    mascotIntroText: {
      fontSize: 16,
      color: '#FFFFFF',
      textAlign: 'center',
      paddingHorizontal: 20,
      lineHeight: 24,
    },
    optionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    optionText: {
      fontSize: 17,
      color: theme.colors.foreground,
    },
    optionTextSelected: {
      fontSize: 17,
      color: theme.colors.button1,
    },
    checkmark: {
      fontSize: 20,
      color: theme.colors.muted,
    },
    checkmarkSelected: {
      fontSize: 20,
      color: theme.colors.button1,
    },
    countrySelector: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    countryFlag: {
      fontSize: 24,
      marginRight: 12,
    },
    countryText: {
      flex: 1,
      fontSize: 17,
      color: theme.colors.foreground,
    },
    countryChevron: {
      fontSize: 20,
      color: theme.colors.muted,
    },
    bottomButtonContainer: {
      paddingHorizontal: 24,
      paddingBottom: 40,
      paddingTop: 20,
    },
    primaryButton: {
      backgroundColor: theme.colors.button1,
      borderRadius: 12,
      paddingVertical: 18,
      alignItems: 'center',
    },
    primaryButtonText: {
      fontSize: 17,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    primaryButtonDisabled: {
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      paddingVertical: 18,
      alignItems: 'center',
    },
    primaryButtonTextDisabled: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.muted,
    },
    // Color swatch styles
    colorOptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    colorSwatch: {
      width: 44,
      height: 44,
      borderRadius: 8,
      marginRight: 16,
    },
    colorSwatchOther: {
      width: 44,
      height: 44,
      borderRadius: 8,
      marginRight: 16,
      backgroundColor: theme.colors.surface3,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    // Body type grid styles
    bodyTypeGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
    bodyTypeCard: {
      width: '48%',
      aspectRatio: 0.85,
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      marginBottom: 12,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    bodyTypeCardSelected: {
      borderColor: theme.colors.button1,
    },
    bodyTypeLabel: {
      fontSize: 14,
      color: theme.colors.muted,
      marginTop: 8,
    },
    bodyTypeEmoji: {
      fontSize: 40,
    },
    // Height/Weight input styles
    unitToggleContainer: {
      flexDirection: 'row',
      marginBottom: 16,
    },
    unitToggle: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      marginRight: 8,
    },
    unitToggleActive: {
      backgroundColor: theme.colors.foreground,
    },
    unitToggleInactive: {
      backgroundColor: theme.colors.surface3,
    },
    unitToggleTextActive: {
      color: theme.colors.surface,
      fontWeight: '600',
    },
    unitToggleTextInactive: {
      color: theme.colors.muted,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 24,
    },
    measureInput: {
      flex: 1,
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 16,
      fontSize: 17,
      color: theme.colors.foreground,
    },
    inputLabel: {
      marginLeft: 8,
      fontSize: 15,
      color: theme.colors.muted,
      width: 24,
    },
    inputNote: {
      fontSize: 13,
      color: theme.colors.muted,
      lineHeight: 18,
    },
    fillLaterButton: {
      alignItems: 'center',
      paddingVertical: 12,
    },
    fillLaterText: {
      fontSize: 15,
      color: theme.colors.muted,
    },
    // Style grid
    styleGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
    styleCard: {
      width: '48%',
      marginBottom: 16,
    },
    styleImageContainer: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: 12,
      backgroundColor: theme.colors.surface3,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    styleImageContainerSelected: {
      borderWidth: 3,
      borderColor: theme.colors.button1,
    },
    styleImage: {
      width: '100%',
      height: '100%',
    },
    styleLabel: {
      fontSize: 14,
      color: theme.colors.muted,
      marginTop: 8,
    },
    // Brand price range styles
    brandCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    brandCardSelected: {
      borderColor: theme.colors.button1,
    },
    brandLabel: {
      fontSize: 16,
      color: theme.colors.foreground,
    },
    brandLogos: {
      flexDirection: 'row',
    },
    brandLogo: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.colors.surface,
      marginLeft: 8,
      justifyContent: 'center',
      alignItems: 'center',
    },
    brandLogoText: {
      fontSize: 8,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    // Chip selection styles
    chipContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 8,
    },
    chip: {
      backgroundColor: theme.colors.surface3,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 12,
      marginRight: 10,
      marginBottom: 10,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    chipSelected: {
      backgroundColor: theme.colors.button1,
      borderColor: theme.colors.button1,
    },
    chipText: {
      fontSize: 15,
      color: theme.colors.foreground,
    },
    chipTextSelected: {
      fontSize: 15,
      color: theme.colors.buttonText1,
    },
    // Simple height input styles
    simpleHeightRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 40,
    },
    simpleHeightInput: {
      width: 80,
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 16,
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.foreground,
      textAlign: 'center',
    },
    simpleHeightLabel: {
      fontSize: 18,
      color: theme.colors.muted,
      marginLeft: 8,
      marginRight: 24,
    },
    // Expandable section styles
    expandableSection: {
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      marginBottom: 12,
      overflow: 'hidden',
    },
    expandableHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    expandableTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    expandableValue: {
      fontSize: 14,
      color: theme.colors.muted,
    },
    expandableChevron: {
      fontSize: 16,
      color: theme.colors.muted,
    },
    expandableContent: {
      paddingHorizontal: 16,
      paddingBottom: 16,
    },
    sizeChipContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginBottom: 12,
    },
    sizeChip: {
      backgroundColor: theme.colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginRight: 8,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    sizeChipSelected: {
      backgroundColor: theme.colors.button1,
      borderColor: theme.colors.button1,
    },
    sizeChipText: {
      fontSize: 14,
      color: theme.colors.foreground,
    },
    sizeChipTextSelected: {
      fontSize: 14,
      color: theme.colors.buttonText1,
    },
    fitLabel: {
      fontSize: 13,
      color: theme.colors.muted,
      marginBottom: 8,
    },
    fitOptionContainer: {
      flexDirection: 'row',
    },
    fitOption: {
      backgroundColor: theme.colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginRight: 8,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    fitOptionSelected: {
      backgroundColor: theme.colors.foreground,
      borderColor: theme.colors.foreground,
    },
    fitOptionText: {
      fontSize: 12,
      color: theme.colors.muted,
    },
    fitOptionTextSelected: {
      fontSize: 12,
      color: theme.colors.surface,
    },
    // Feature showcase styles
    featureSlideContainer: {
      width,
      flex: 1,
      backgroundColor: theme.colors.surface,
      paddingTop: 180,
    },
    featureContent: {
      flex: 1,
      justifyContent: 'flex-start',
      alignItems: 'center',
      paddingHorizontal: 24,
    },
    phoneMockup: {
      width: width * 0.8,
      height: width * 0.9,
      backgroundColor: theme.colors.surface3,
      borderRadius: 24,
      shadowColor: theme.colors.foreground,
      shadowOffset: {width: 0, height: 8},
      shadowOpacity: 0.15,
      shadowRadius: 24,
      elevation: 8,
      overflow: 'hidden',
      marginBottom: 40,
    },
    phoneMockupImage: {
      width: '100%',
      height: '100%',
      borderRadius: 24,
    },
    featureTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.foreground,
      textAlign: 'center',
      marginBottom: 40,
    },
    featureDotsContainer: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginBottom: 20,
    },
    featureDot: {
      height: 8,
      borderRadius: 4,
      marginHorizontal: 4,
    },
    featureDotActive: {
      width: 24,
      backgroundColor: theme.colors.button1,
    },
    featureDotInactive: {
      width: 8,
      backgroundColor: theme.colors.muted,
    },
    featureButton: {
      backgroundColor: theme.colors.button1,
      borderRadius: 12,
      paddingVertical: 18,
      paddingHorizontal: 60,
      alignItems: 'center',
      marginHorizontal: 24,
      marginBottom: 40,
    },
    fixedBottomContainer: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.surface,
      paddingTop: 20,
    },
    featureButtonText: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.buttonText1,
    },
    // Stats/laurel styles
    statsContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    statRow: {
      alignItems: 'center',
      marginBottom: 40,
    },
    laurelContainer: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    laurelLeft: {
      fontSize: 50,
      transform: [{scaleX: -1}],
    },
    laurelRight: {
      fontSize: 50,
    },
    statNumber: {
      fontSize: 32,
      fontWeight: '700',
      color: theme.colors.button1,
    },
    statLabel: {
      fontSize: 16,
      color: theme.colors.button1,
    },
    // Chat bubble styles for AI stylist
    chatContainer: {
      padding: 16,
    },
    chatBubbleRight: {
      alignSelf: 'flex-end',
      backgroundColor: theme.colors.surface3,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 10,
      marginBottom: 12,
      maxWidth: '80%',
    },
    chatBubbleLeft: {
      alignSelf: 'flex-start',
      backgroundColor: theme.colors.button1,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      marginBottom: 12,
      maxWidth: '80%',
    },
    chatBubbleText: {
      fontSize: 14,
      color: theme.colors.foreground,
    },
    chatBubbleTextWhite: {
      fontSize: 14,
      color: theme.colors.buttonText1,
    },
    chatBubbleTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.buttonText1,
      marginBottom: 4,
    },
    clothingPreview: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginBottom: 12,
    },
    clothingItem: {
      width: 80,
      height: 80,
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      marginHorizontal: 6,
    },
    // AI cleanup comparison
    aiComparisonContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 20,
    },
    beforeImage: {
      width: width * 0.35,
      height: width * 0.45,
      borderRadius: 12,
      backgroundColor: theme.colors.surface3,
    },
    aiCleanupCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      padding: 12,
      shadowColor: theme.colors.foreground,
      shadowOffset: {width: 0, height: 4},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 4,
      marginLeft: -20,
    },
    aiLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
    },
    aiLabelText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.button1,
      marginRight: 4,
    },
    afterImage: {
      width: width * 0.4,
      height: width * 0.5,
      borderRadius: 12,
      backgroundColor: theme.colors.surface3,
    },
    // Calendar Feature Slide styles
    calendarPreview: {
      width: '100%',
      height: '100%',
      backgroundColor: theme.colors.surface2,
      borderRadius: 16,
      padding: 16,
    },
    calendarHeader: {
      marginBottom: 16,
    },
    calendarMonthText: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.foreground,
      textAlign: 'center',
    },
    calendarGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      marginBottom: 16,
    },
    calendarDayLabel: {
      width: '14%',
      textAlign: 'center',
      fontSize: 12,
      color: theme.colors.muted,
      marginBottom: 8,
    },
    calendarDay: {
      width: '14%',
      aspectRatio: 1,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 8,
    },
    calendarDayHighlighted: {
      backgroundColor: theme.colors.primary,
    },
    calendarDayText: {
      fontSize: 14,
      color: theme.colors.foreground,
    },
    calendarDayTextHighlighted: {
      color: '#fff',
      fontWeight: '600',
    },
    outfitDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: '#fff',
      marginTop: 2,
    },
    eventCard: {
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      padding: 12,
      marginTop: 8,
    },
    eventCardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    eventCardSubtitle: {
      fontSize: 12,
      color: theme.colors.muted,
      marginTop: 2,
    },
    // Community Feature Slide styles
    communityGrid: {
      width: width * 0.8,
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: 8,
    },
    communityImage: {
      width: (width * 0.8 - 8) / 2,
      height: (width * 0.8 - 8) / 2,
      borderRadius: 12,
      backgroundColor: theme.colors.surface3,
    },
    // Trends Feature Slide styles
    trendsContainer: {
      width: '100%',
      height: '100%',
      padding: 16,
      justifyContent: 'center',
      gap: 12,
    },
    trendCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 16,
      padding: 16,
    },
    trendLabel: {
      fontSize: 12,
      color: theme.colors.primary,
      fontWeight: '600',
      marginBottom: 4,
    },
    trendTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: 8,
    },
    trendTagRow: {
      flexDirection: 'row',
      gap: 8,
    },
    trendTag: {
      backgroundColor: theme.colors.surface3,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
    },
    trendTagText: {
      fontSize: 12,
      color: theme.colors.foreground,
    },
    // Shopping Feature Slide styles
    shoppingContainer: {
      width: width * 0.85,
      gap: 12,
    },
    shoppingCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 16,
      flexDirection: 'row',
      overflow: 'hidden',
    },
    shoppingImage: {
      width: 100,
      height: 100,
    },
    shoppingInfo: {
      flex: 1,
      padding: 16,
      justifyContent: 'center',
    },
    shoppingItemName: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.foreground,
      marginBottom: 4,
    },
    shoppingMatch: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    // Weather Feature Slide styles
    weatherContainer: {
      width: '100%',
      height: '100%',
      padding: 20,
      justifyContent: 'center',
    },
    weatherHeader: {
      alignItems: 'center',
      marginBottom: 24,
    },
    weatherTemp: {
      fontSize: 48,
      fontWeight: '700',
      color: theme.colors.foreground,
    },
    weatherDesc: {
      fontSize: 16,
      color: theme.colors.muted,
      marginTop: 4,
    },
    weatherOutfitCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 16,
      padding: 16,
    },
    weatherOutfitLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 12,
    },
    weatherOutfitRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
    },
    weatherOutfitItem: {
      alignItems: 'center',
    },
    weatherItemIcon: {
      fontSize: 32,
      marginBottom: 8,
    },
    weatherItemText: {
      fontSize: 12,
      color: theme.colors.foreground,
    },
    // Analytics Feature Slide styles
    analyticsContainer: {
      width: '100%',
      height: '100%',
      padding: 20,
      justifyContent: 'center',
    },
    analyticsTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.foreground,
      textAlign: 'center',
      marginBottom: 20,
    },
    analyticsRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginBottom: 20,
    },
    analyticsStat: {
      alignItems: 'center',
    },
    analyticsNumber: {
      fontSize: 32,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    analyticsLabel: {
      fontSize: 12,
      color: theme.colors.muted,
      marginTop: 4,
    },
    analyticsInsight: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      padding: 16,
    },
    analyticsInsightText: {
      fontSize: 14,
      color: theme.colors.foreground,
      textAlign: 'center',
      fontStyle: 'italic',
    },
  });

  const scrollX = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [scrollEnabled, setScrollEnabled] = useState(true);

  // NEW → Required to prevent FlatList jumping to slide 6
  const [ready, setReady] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setReady(true));
  }, []);

  // Disable swiping on the "Get to know you" slide (index 7) and after
  useEffect(() => {
    setScrollEnabled(currentIndex < 9);
  }, [currentIndex]);

  // ------------------------
  // OLD FORM STATE
  // ------------------------
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    profession: '',
    fashion_level: '',
    gender_presentation: '',
  });

  const [showFashionPicker, setShowFashionPicker] = useState(false);
  const [showGenderPicker, setShowGenderPicker] = useState(false);
  const [customFashionLevel, setCustomFashionLevel] = useState('');

  // New onboarding state
  const [selectedGender, setSelectedGender] = useState<string | null>(null);
  const [selectedCountryCode, setSelectedCountryCode] = useState('US');
  const selectedCountryCodeRef = React.useRef(selectedCountryCode);
  React.useEffect(() => {
    selectedCountryCodeRef.current = selectedCountryCode;
  }, [selectedCountryCode]);
  const handleSaveRef = React.useRef<() => void>(() => {});
  const [selectedLifestyle, setSelectedLifestyle] = useState<string | null>(
    null,
  );
  const [showCountryPicker, setShowCountryPicker] = useState(false);

  // New state for additional screens
  const [selectedHairColor, setSelectedHairColor] = useState<string | null>(
    null,
  );
  const [selectedEyeColor, setSelectedEyeColor] = useState<string | null>(null);
  const [selectedBodyType, setSelectedBodyType] = useState<string | null>(null);
  const [heightUnit, setHeightUnit] = useState<'ft' | 'cm'>('ft');
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'kg'>('lbs');
  const [heightFeet, setHeightFeet] = useState('');
  const [heightInches, setHeightInches] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weight, setWeight] = useState('');
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [selectedPersonalityTraits, setSelectedPersonalityTraits] = useState<
    string[]
  >([]);

  // New state for shopping priorities, clothing types, and sizes
  const [selectedShoppingPriorities, setSelectedShoppingPriorities] = useState<
    string[]
  >([]);
  const [selectedClothingTypes, setSelectedClothingTypes] = useState<string[]>(
    [],
  );
  const [simpleHeightFeet, setSimpleHeightFeet] = useState('');
  const [simpleHeightInches, setSimpleHeightInches] = useState('');
  const [expandedSizeSection, setExpandedSizeSection] = useState<string | null>(
    null,
  );
  const [sizes, setSizes] = useState<{
    shirt: {size: string | null; fit: string | null};
    waist: {size: string | null; fit: string | null};
    inseam: {size: string | null; fit: string | null};
    blazer: {size: string | null; fit: string | null};
    shoe: {size: string | null; fit: string | null};
  }>({
    shirt: {size: null, fit: null},
    waist: {size: null, fit: null},
    inseam: {size: null, fit: null},
    blazer: {size: null, fit: null},
    shoe: {size: null, fit: null},
  });

  // State for favorite brands
  const [favoriteBrands, setFavoriteBrands] = useState<string[]>([]);
  const [newBrandInput, setNewBrandInput] = useState('');

  // Navigation helper
  const goToSlide = (slideIndex: number) => {
    flatListRef.current?.scrollToIndex({
      index: slideIndex,
      animated: true,
    });
    setCurrentIndex(slideIndex);
  };

  const goToNextSlide = () => {
    goToSlide(currentIndex + 1);
  };

  const goToPrevSlide = () => {
    if (currentIndex > 0) {
      goToSlide(currentIndex - 1);
    }
  };

  const handleChange = (field, val) => {
    setForm(prev => ({...prev, [field]: val}));
  };

  const normalizeGender = s => s.trim().toLowerCase().replace(/\s+/g, '_');

  const resolveUserId = async token => {
    let id = userId;
    if (!id && token) {
      try {
        const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
          headers: {Authorization: `Bearer ${token}`},
        });
        const prof = await profRes.json().catch(() => ({}));
        id = prof?.id || prof?.uuid || null;
      } catch {}
    }
    return id;
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);

    try {
      const token = await getAccessToken();
      const id = await resolveUserId(token);

      // Build user payload directly here to avoid stale closure issues
      const userPayload: Record<string, any> = {onboarding_complete: true};
      for (const [k, v] of Object.entries(form)) {
        const trimmed = typeof v === 'string' ? v.trim() : v;
        if (trimmed) userPayload[k] = trimmed;
      }
      // Handle custom fashion level
      if (userPayload.fashion_level === 'Other' && customFashionLevel.trim()) {
        userPayload.fashion_level = customFashionLevel.trim();
      } else if (userPayload.fashion_level === 'Other') {
        delete userPayload.fashion_level;
      }
      if (userPayload.gender_presentation) {
        userPayload.gender_presentation = normalizeGender(
          userPayload.gender_presentation,
        );
      }
      userPayload.country = selectedCountryCodeRef.current || 'US';
      console.log(
        '🚨 COUNTRY VALUE:',
        selectedCountryCodeRef.current,
        'PAYLOAD:',
        JSON.stringify(userPayload),
      );

      if (id && token) {
        await fetch(`${API_BASE_URL}/users/me`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(userPayload),
        });

        // Convert and save style profile
        const heightCmVal =
          simpleHeightFeet || simpleHeightInches
            ? Math.round(
                ((parseFloat(simpleHeightFeet) || 0) * 12 +
                  (parseFloat(simpleHeightInches) || 0)) *
                  2.54,
              )
            : heightFeet || heightInches
            ? Math.round(
                ((parseFloat(heightFeet) || 0) * 12 +
                  (parseFloat(heightInches) || 0)) *
                  2.54,
              )
            : heightCm
            ? parseFloat(heightCm)
            : null;

        const weightKgVal = weight
          ? weightUnit === 'kg'
            ? parseFloat(weight)
            : Math.round(parseFloat(weight) * 0.453592)
          : null;


        const styleProfilePayload: Record<string, any> = {
          is_style_profile_complete: true,
        };

        if (selectedHairColor)
          styleProfilePayload.hair_color = selectedHairColor;
        if (selectedEyeColor) styleProfilePayload.eye_color = selectedEyeColor;
        if (selectedBodyType) styleProfilePayload.body_type = selectedBodyType;
        if (selectedLifestyle)
          styleProfilePayload.lifestyle_notes = selectedLifestyle;
        if (heightCmVal) styleProfilePayload.height = heightCmVal;
        if (weightKgVal) styleProfilePayload.weight = weightKgVal;
        if (selectedStyles.length > 0)
          styleProfilePayload.style_preferences = selectedStyles;
        if (budgetMin) styleProfilePayload.budget_min = budgetMin;
        if (budgetMax) styleProfilePayload.budget_max = budgetMax;
        if (selectedShoppingPriorities.length > 0)
          styleProfilePayload.fit_preferences = selectedShoppingPriorities;
        if (selectedPersonalityTraits.length > 0)
          styleProfilePayload.personality_traits = selectedPersonalityTraits;
        if (favoriteBrands.length > 0)
          styleProfilePayload.preferred_brands = favoriteBrands;

        const prefsJsonb: Record<string, any> = {};
        if (selectedClothingTypes.length > 0)
          prefsJsonb.clothing_types = selectedClothingTypes;
        const hasAnySizes = Object.values(sizes).some(s => s.size || s.fit);
        if (hasAnySizes) prefsJsonb.sizes = sizes;
        if (Object.keys(prefsJsonb).length > 0)
          styleProfilePayload.prefs_jsonb = prefsJsonb;

        await fetch(`${API_BASE_URL}/style-profile`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(styleProfilePayload),
        });
      }

      // Mark onboarding complete
      await AsyncStorage.setItem('onboarding_complete', 'true');

      // 👇 NEW: go to the LAST CARD (GetStarted)
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({
          index: 22,
          animated: true,
        });
      });
    } catch (err) {
      await AsyncStorage.setItem('onboarding_complete', 'true');

      // still go to last card even if the request fails
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({
          index: 22,
          animated: true,
        });
      });
    } finally {
      setSaving(false);
    }
  };

  // Keep handleSaveRef updated
  handleSaveRef.current = handleSave;

  // ------------------------
  // OLD FORM SLIDE
  // ------------------------
  const OldFormSlide = (
    <View style={{flex: 1, backgroundColor: theme.colors.surface}}>
      <TouchableOpacity
        style={{position: 'absolute', top: 60, left: 20, zIndex: 10, padding: 8}}
        onPress={goToPrevSlide}>
        <Text style={styles.backButtonText}>‹</Text>
      </TouchableOpacity>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={[styles.formContainer, {backgroundColor: theme.colors.surface}]}>
        <Animatable.View
        animation="fadeInUp"
        duration={600}
        style={[styles.card, {backgroundColor: theme.colors.surface}]}>
        <Text style={[styles.title, {color: theme.colors.button1}]}>
          Personal Information
        </Text>

        <Text style={styles.label}>First Name</Text>
        <TextInput
          style={[styles.input, {backgroundColor: theme.colors.surface3}]}
          placeholder="Enter first name"
          placeholderTextColor={theme.colors.inputText1}
          value={form.first_name}
          onChangeText={val => handleChange('first_name', val)}
        />

        <Text style={styles.label}>Last Name</Text>
        <TextInput
          style={[styles.input, {backgroundColor: theme.colors.surface3}]}
          placeholder="Enter last name"
          placeholderTextColor={theme.colors.inputText1}
          value={form.last_name}
          onChangeText={val => handleChange('last_name', val)}
        />

        <Text style={styles.label}>Profession</Text>
        <TextInput
          style={[styles.input, {backgroundColor: theme.colors.surface3}]}
          placeholder="Enter profession"
          placeholderTextColor={theme.colors.inputText1}
          value={form.profession}
          onChangeText={val => handleChange('profession', val)}
        />

        <Text style={styles.label}>Fashion Level</Text>
        <TouchableOpacity
          activeOpacity={0.8}
          style={[
            styles.selectorButton,
            {
              backgroundColor: theme.colors.surface3,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
          onPress={() => setShowFashionPicker(true)}>
          <Text style={[styles.selectorText, {color: theme.colors.muted}]}>
            {form.fashion_level === 'Other' && customFashionLevel
              ? customFashionLevel
              : form.fashion_level || 'Select fashion level'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.label}>Gender Presentation</Text>
        <TouchableOpacity
          activeOpacity={0.8}
          style={[
            styles.selectorButton,
            {
              backgroundColor: theme.colors.surface3,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
          onPress={() => setShowGenderPicker(true)}>
          <Text style={[styles.selectorText, {color: theme.colors.muted}]}>
            {form.gender_presentation || 'Select gender presentation'}
          </Text>
        </TouchableOpacity>

        <AppleTouchFeedback hapticStyle="impactMedium">
          <TouchableOpacity
            style={[styles.button, {backgroundColor: theme.colors.button1}]}
            activeOpacity={0.85}
            onPress={() => handleSaveRef.current()}
            disabled={saving}>
            {saving ? (
              <ActivityIndicator />
            ) : (
              <Text
                style={[styles.buttonText, {color: theme.colors.buttonText1}]}>
                Save Profile
              </Text>
            )}
          </TouchableOpacity>
        </AppleTouchFeedback>
      </Animatable.View>

      {/* FASHION PICKER MODAL */}
      <Modal visible={showFashionPicker} transparent animationType="slide">
        <View style={styles.modalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowFashionPicker(false)}>
            <View style={styles.backdropHitArea} />
          </TouchableWithoutFeedback>

          <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
            <View style={styles.sheetToolbar}>
              <TouchableOpacity onPress={() => setShowFashionPicker(false)}>
                <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
                  Done
                </Text>
              </TouchableOpacity>
            </View>

            <Picker
              selectedValue={form.fashion_level === 'Other' || (form.fashion_level && !['Expert', 'Intermediate', 'Novice', ''].includes(form.fashion_level)) ? 'Other' : form.fashion_level}
              onValueChange={val => {
                if (val === 'Other') {
                  handleChange('fashion_level', 'Other');
                } else {
                  handleChange('fashion_level', val);
                  setCustomFashionLevel('');
                }
              }}
              itemStyle={{
                color: theme.colors.foreground,
                fontSize: 18,
                fontWeight: '500',
              }}>
              <Picker.Item label="Select fashion level" value="" />
              <Picker.Item label="Expert" value="Expert" />
              <Picker.Item label="Intermediate" value="Intermediate" />
              <Picker.Item label="Novice" value="Novice" />
              <Picker.Item label="Other" value="Other" />
            </Picker>
            {(form.fashion_level === 'Other' || (form.fashion_level && !['Expert', 'Intermediate', 'Novice', ''].includes(form.fashion_level))) && (
              <View style={{paddingHorizontal: 16, paddingBottom: 16}}>
                <TextInput
                  style={{
                    backgroundColor: theme.colors.surface3,
                    borderRadius: 10,
                    padding: 12,
                    color: theme.colors.foreground,
                    borderWidth: 1,
                    borderColor: theme.colors.surfaceBorder,
                  }}
                  placeholder="Enter your style level"
                  placeholderTextColor={theme.colors.muted}
                  value={customFashionLevel}
                  onChangeText={setCustomFashionLevel}
                  maxLength={50}
                />
                <Text style={{fontSize: 12, color: theme.colors.muted, textAlign: 'right', marginTop: 4}}>
                  {customFashionLevel.length}/50
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* GENDER PICKER MODAL */}
      <Modal visible={showGenderPicker} transparent animationType="slide">
        <View style={styles.modalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowGenderPicker(false)}>
            <View style={styles.backdropHitArea} />
          </TouchableWithoutFeedback>

          <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
            <View style={styles.sheetToolbar}>
              <TouchableOpacity onPress={() => setShowGenderPicker(false)}>
                <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
                  Done
                </Text>
              </TouchableOpacity>
            </View>

            <Picker
              selectedValue={form.gender_presentation}
              onValueChange={val => handleChange('gender_presentation', val)}
              itemStyle={{
                color: theme.colors.foreground,
                fontSize: 18,
                fontWeight: '500',
              }}>
              <Picker.Item label="Select gender presentation" value="" />
              <Picker.Item label="Male" value="Male" />
              <Picker.Item label="Female" value="Female" />
              <Picker.Item label="Other" value="Other" />
            </Picker>
          </View>
        </View>
      </Modal>
    </ScrollView>
    </View>
  );

  // ------------------------
  // CARDS
  // ------------------------
  const Step = ({title, description, image}) => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <Image
            source={image}
            style={styles.phoneMockupImage}
            resizeMode="cover"
          />
        </View>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.stepDescription}>{description}</Text>
      </View>
    </View>
  );

  //   const handleSave = async () => {
  //     if (saving) return;
  //     setSaving(true);

  //     try {
  //       const token = await getAccessToken();
  //       const id = await resolveUserId(token || null);
  //       const payload = buildPayload();

  //       if (id && token) {
  //         await fetch(`${API_BASE_URL}/users/${id}`, {
  //           method: 'PUT',
  //           headers: {
  //             'Content-Type': 'application/json',
  //             Authorization: `Bearer ${token}`,
  //           },
  //           body: JSON.stringify(payload),
  //         });
  //       }

  //       await AsyncStorage.setItem('onboarding_complete', 'true');
  //       navigate('Home');
  //     } catch (err) {
  //       await AsyncStorage.setItem('onboarding_complete', 'true');
  //       navigate('Home');
  //     } finally {
  //       setSaving(false);
  //     }
  //   };

  // ------------------------
  // FEATURE SHOWCASE SLIDES
  // ------------------------

  // Feature Slide 1: Closet - "All your clothes, one glance"
  const ClosetFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <Image
            source={require('../assets/images/landing-page16.webp')}
            style={styles.phoneMockupImage}
            resizeMode="cover"
          />
        </View>
        <Text style={styles.featureTitle}>
          Outfits that work,{'\n'} built from your actual wardrobe
        </Text>
      </View>
    </View>
  );

  // Feature Slide 2: AI Stylist - "Meet your personal AI stylist"
  const AIStylistFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <View style={styles.chatContainer}>
            <View style={styles.clothingPreview}>
              <Image
                source={require('../assets/images/landing-page14.webp')}
                style={styles.clothingItem}
                resizeMode="cover"
              />
              <Image
                source={require('../assets/images/landing-page15.webp')}
                style={styles.clothingItem}
                resizeMode="cover"
              />
            </View>
            <View style={styles.chatBubbleRight}>
              <Text style={styles.chatBubbleText}>Does this item suit me?</Text>
            </View>
            <View style={styles.chatBubbleLeft}>
              <Text style={styles.chatBubbleTitle}>90% perfect match!</Text>
              <Text style={styles.chatBubbleTextWhite}>
                The color and fit look great on you
              </Text>
            </View>
            <View style={styles.chatBubbleRight}>
              <Text style={styles.chatBubbleText}>Thanks!</Text>
            </View>
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Ask Styla, your personal AI stylist for fashion guidance
        </Text>
      </View>
    </View>
  );

  // Feature Slide 3: AI Cleanup - "Snap a worn look, AI cleans it up"
  const AICleanupFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={[styles.aiComparisonContainer, {marginBottom: 40}]}>
          <Image
            source={require('../assets/images/landing-page16.webp')}
            style={styles.beforeImage}
            resizeMode="cover"
          />
          <View style={styles.aiCleanupCard}>
            <View style={styles.aiLabel}>
              <Text style={styles.aiLabelText}>AI</Text>
              <Text style={{fontSize: 16}}>✨</Text>
            </View>
            <Image
              source={require('../assets/images/landing-page17.webp')}
              style={styles.afterImage}
              resizeMode="cover"
            />
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Take a snap of looks that you like, and find or recreate all the
          pieces
        </Text>
      </View>
    </View>
  );

  // Feature Slide 4: Wardrobe Calendar - Plan outfits for events
  const CalendarFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <View style={styles.calendarPreview}>
            <View style={styles.calendarHeader}>
              <Text style={styles.calendarMonthText}>December 2025</Text>
            </View>
            <View style={styles.calendarGrid}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => (
                <Text key={i} style={styles.calendarDayLabel}>
                  {day}
                </Text>
              ))}
              {[15, 16, 17, 18, 19, 20, 21].map(day => (
                <View
                  key={day}
                  style={[
                    styles.calendarDay,
                    day === 18 && styles.calendarDayHighlighted,
                  ]}>
                  <Text
                    style={[
                      styles.calendarDayText,
                      day === 18 && styles.calendarDayTextHighlighted,
                    ]}>
                    {day}
                  </Text>
                  {day === 18 && <View style={styles.outfitDot} />}
                </View>
              ))}
            </View>
            <View style={styles.eventCard}>
              <Text style={styles.eventCardTitle}>Holiday Party</Text>
              <Text style={styles.eventCardSubtitle}>Outfit planned</Text>
            </View>
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Plan your outfits ahead{'\n'}for any occasion synced to your phone's
          calendar
        </Text>
      </View>
    </View>
  );

  // Feature Slide 5: Community & Sharing - Share and get inspired
  const CommunityFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={[styles.communityGrid, {marginBottom: 40}]}>
          <Image
            source={require('../assets/images/landing-page21.jpg')}
            style={styles.communityImage}
            resizeMode="cover"
          />
          <Image
            source={require('../assets/images/landing-page22.jpg')}
            style={styles.communityImage}
            resizeMode="cover"
          />
          <Image
            source={require('../assets/images/landing-page23.jpg')}
            style={styles.communityImage}
            resizeMode="cover"
          />
          <Image
            source={require('../assets/images/landing-page24.jpg')}
            style={styles.communityImage}
            resizeMode="cover"
          />
        </View>
        <Text style={styles.featureTitle}>
          Share your looks and get{'\n'}inspired by the community
        </Text>
      </View>
    </View>
  );

  // Feature Slide 6: Style Trends - Personalized fashion trends
  const TrendsFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <View style={styles.trendsContainer}>
            <View style={styles.trendCard}>
              <Text style={styles.trendLabel}>Trending Now</Text>
              <Text style={styles.trendTitle}>Cozy Minimalism</Text>
              <View style={styles.trendTagRow}>
                <View style={styles.trendTag}>
                  <Text style={styles.trendTagText}>Neutral Tones</Text>
                </View>
                <View style={styles.trendTag}>
                  <Text style={styles.trendTagText}>Layering</Text>
                </View>
              </View>
            </View>
            <View style={styles.trendCard}>
              <Text style={styles.trendLabel}>For You</Text>
              <Text style={styles.trendTitle}>Bold Accessories</Text>
              <View style={styles.trendTagRow}>
                <View style={styles.trendTag}>
                  <Text style={styles.trendTagText}>Statement</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Stay ahead with personalized{'\n'}style trends just for you
        </Text>
      </View>
    </View>
  );

  // Feature Slide 7: Shopping - Find items that match your style
  const ShoppingFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={[styles.shoppingContainer, {marginBottom: 40}]}>
          <View style={styles.shoppingCard}>
            <Image
              source={require('../assets/images/landing-page25.jpg')}
              style={styles.shoppingImage}
              resizeMode="cover"
            />
            <View style={styles.shoppingInfo}>
              <Text style={styles.shoppingItemName}>Classic Blazer</Text>
              <Text style={styles.shoppingMatch}>98% match</Text>
            </View>
          </View>
          <View style={styles.shoppingCard}>
            <Image
              source={require('../assets/images/landing-page26.jpg')}
              style={styles.shoppingImage}
              resizeMode="cover"
            />
            <View style={styles.shoppingInfo}>
              <Text style={styles.shoppingItemName}>Silk Blouse</Text>
              <Text style={styles.shoppingMatch}>95% match</Text>
            </View>
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Shop pieces that perfectly{'\n'}match your style profile
        </Text>
      </View>
    </View>
  );

  // Feature Slide 8: Weather Outfits - Dress for the weather
  const WeatherFeatureSlide = () => (
    <View style={styles.featureSlideContainer}>
      <View style={styles.featureContent}>
        <View style={styles.phoneMockup}>
          <View style={styles.weatherContainer}>
            <View style={styles.weatherHeader}>
              <Text style={styles.weatherTemp}>72°F</Text>
              <Text style={styles.weatherDesc}>Partly Cloudy</Text>
            </View>
            <View style={styles.weatherOutfitCard}>
              <Text style={styles.weatherOutfitLabel}>Today's Pick</Text>
              <View style={styles.weatherOutfitRow}>
                <View style={styles.weatherOutfitItem}>
                  <Text style={styles.weatherItemIcon}>👕</Text>
                  <Text style={styles.weatherItemText}>Light Layer</Text>
                </View>
                <View style={styles.weatherOutfitItem}>
                  <Text style={styles.weatherItemIcon}>👖</Text>
                  <Text style={styles.weatherItemText}>Chinos</Text>
                </View>
                <View style={styles.weatherOutfitItem}>
                  <Text style={styles.weatherItemIcon}>👟</Text>
                  <Text style={styles.weatherItemText}>Sneakers</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
        <Text style={styles.featureTitle}>
          Get outfit suggestions{'\n'}based on the weather and location
        </Text>
      </View>
    </View>
  );

  // ------------------------
  // NEW ONBOARDING SLIDES
  // ------------------------

  // Slide 6: Get to know you intro
  const GetToKnowYouSlide = () => (
    <View style={styles.onboardingContainer}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 24,
        }}>
        <Text style={styles.onboardingTitleCentered}>
          Hi I'm Styla, your personalized fashion assistant. I can't wait to
          help you look your best. Let's get started!
        </Text>
        <Image
          source={require('../assets/images/Styla1.png')}
          style={styles.mascotImage}
          resizeMode="contain"
        />
      </View>
      <View style={styles.bottomButtonContainer}>
        <TouchableOpacity style={styles.primaryButton} onPress={goToNextSlide}>
          <Text style={styles.primaryButtonText}>I'm ready</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Slide 7: Gender selection
  const genderOptions = ['Female', 'Male', 'Non-binary', 'Rather Not Say'];
  const GenderSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>What is your gender?</Text>
        {genderOptions.map(option => (
          <TouchableOpacity
            key={option}
            style={styles.optionRow}
            onPress={() => {
              setSelectedGender(option);
              setTimeout(goToNextSlide, 300);
            }}>
            <Text
              style={
                selectedGender === option
                  ? styles.optionTextSelected
                  : styles.optionText
              }>
              {option}
            </Text>
            <Text
              style={
                selectedGender === option
                  ? styles.checkmarkSelected
                  : styles.checkmark
              }>
              ✓
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  // Slide 8: Location selection - using ISO country list
  const allCountries = useMemo(() => getData(), []);
  const getCountryName = (code: string) => {
    const country = allCountries.find(c => c.code === code);
    return country ? country.name : code;
  };

  const LocationSlide = () => {
    return (
      <View style={styles.onboardingContainer}>
        <View style={styles.onboardingHeader}>
          <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.onboardingContent}>
          <Text style={styles.onboardingTitle}>What country do you reside in</Text>
          <TouchableOpacity
            style={styles.countrySelector}
            onPress={() => setShowCountryPicker(true)}>
            <Text style={styles.countryText}>
              {getCountryName(selectedCountryCode)}
            </Text>
            <Text style={styles.countryChevron}>⌄</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={goToNextSlide}>
            <Text style={styles.primaryButtonText}>Next</Text>
          </TouchableOpacity>
        </View>

        {/* Country Picker Modal */}
        <Modal visible={showCountryPicker} transparent animationType="slide">
          <View style={styles.modalRoot}>
            <TouchableWithoutFeedback
              onPress={() => setShowCountryPicker(false)}>
              <View style={styles.backdropHitArea} />
            </TouchableWithoutFeedback>
            <View
              style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
              <View style={styles.sheetToolbar}>
                <TouchableOpacity onPress={() => setShowCountryPicker(false)}>
                  <Text
                    style={{color: theme.colors.button1, fontWeight: '600'}}>
                    Done
                  </Text>
                </TouchableOpacity>
              </View>
              <Picker
                selectedValue={selectedCountryCode}
                onValueChange={val => setSelectedCountryCode(val)}
                itemStyle={{
                  color: theme.colors.foreground,
                  fontSize: 18,
                  fontWeight: '500',
                }}>
                {allCountries.map(c => (
                  <Picker.Item key={c.code} label={c.name} value={c.code} />
                ))}
              </Picker>
            </View>
          </View>
        </Modal>
      </View>
    );
  };

  // Slide 9: Lifestyle selection
  const lifestyleOptions = [
    'Middle/High school student',
    'University student',
    'Casual attire worker',
    'Formal attire worker',
    'Uniformed worker',
    'Homemaker',
    'Other',
  ];
  const LifestyleSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>
          What is your primary lifestyle and work type?
        </Text>
        <ScrollView showsVerticalScrollIndicator={false}>
          {lifestyleOptions.map(option => (
            <TouchableOpacity
              key={option}
              style={styles.optionRow}
              onPress={() => {
                setSelectedLifestyle(option);
                setTimeout(goToNextSlide, 300);
              }}>
              <Text
                style={
                  selectedLifestyle === option
                    ? styles.optionTextSelected
                    : styles.optionText
                }>
                {option}
              </Text>
              <Text
                style={
                  selectedLifestyle === option
                    ? styles.checkmarkSelected
                    : styles.checkmark
                }>
                ✓
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );

  // Slide: Favorite Brands
  const handleAddBrand = () => {
    const input = newBrandInput.trim();
    if (!input) return;

    // Split on commas to handle "Nike, Adidas" as separate brands
    const newBrands = input
      .split(',')
      .map(b => b.trim())
      .filter(b => b.length > 0)
      .filter(b => !favoriteBrands.some(
        existing => existing.toLowerCase() === b.toLowerCase()
      ));

    if (newBrands.length > 0) {
      setFavoriteBrands([...favoriteBrands, ...newBrands]);
    }
    setNewBrandInput('');
  };

  const removeBrand = (brand: string) => {
    setFavoriteBrands(favoriteBrands.filter(b => b !== brand));
  };

  const toggleBrand = (brand: string) => {
    if (favoriteBrands.includes(brand)) {
      setFavoriteBrands(favoriteBrands.filter(b => b !== brand));
    } else {
      setFavoriteBrands([...favoriteBrands, brand]);
    }
  };

  // Merge preset brands + any manually added brands not already in presets
  const allBrandTiles = useMemo(() => {
    const presetLower = new Set(presetBrandNames.map(b => b.toLowerCase()));
    const customBrands = favoriteBrands.filter(b => !presetLower.has(b.toLowerCase()));
    return [...presetBrandNames, ...customBrands];
  }, [presetBrandNames, favoriteBrands]);

  const FavoriteBrandsSlideElement = (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={20}>
        <ScrollView
          style={styles.onboardingContent}
          contentContainerStyle={{paddingBottom: 20}}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <Text style={styles.onboardingTitle}>What are your favorite brands?</Text>
          <Text style={{color: theme.colors.muted, fontSize: 14, marginBottom: 16, textAlign: 'center'}}>
            Tap to select, or add your own below
          </Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between'}}>
            {allBrandTiles.map(brand => {
              const isSelected = favoriteBrands.some(
                b => b.toLowerCase() === brand.toLowerCase(),
              );
              return (
                <TouchableOpacity
                  key={brand}
                  onPress={() => toggleBrand(brand)}
                  style={{
                    width: '48%',
                    borderWidth: 1.5,
                    borderRadius: 10,
                    borderColor: isSelected ? theme.colors.primary : theme.colors.inputBorder,
                    backgroundColor: isSelected ? theme.colors.foreground + '15' : theme.colors.background,
                    paddingVertical: 14,
                    paddingHorizontal: 8,
                    marginBottom: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '500',
                      color: isSelected ? theme.colors.background : theme.colors.foreground,
                      textAlign: 'center',
                    }}
                    numberOfLines={1}>
                    {brand}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{marginTop: 12}}>
            <TextInput
              placeholder="Add a brand"
              placeholderTextColor={theme.colors.muted}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: 8,
                padding: 12,
                fontSize: 16,
                backgroundColor: theme.colors.input2,
                color: theme.colors.foreground,
                width: '100%',
                marginBottom: 8,
              }}
              value={newBrandInput}
              onChangeText={setNewBrandInput}
              onSubmitEditing={handleAddBrand}
              blurOnSubmit={false}
              returnKeyType="done"
            />
            <TouchableOpacity
              onPress={handleAddBrand}
              style={{
                alignSelf: 'center',
                paddingVertical: 8,
                paddingHorizontal: 16,
              }}>
              <Text style={{color: theme.colors.primary, fontSize: 15, fontWeight: '600'}}>
                + Add More
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={goToNextSlide}>
            <Text style={styles.primaryButtonText}>Next</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );

  // Slide 6: Hair Color selection
  const hairColorOptions = ['Black', 'Brown', 'Blonde', 'Red', 'Gray', 'White', 'Dyed', 'Other'];
  const HairColorSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>What color is your hair?</Text>
        <View style={globalStyles.pillContainer}>
          {hairColorOptions.map(color => (
            <Chip
              key={color}
              label={color}
              selected={selectedHairColor === color}
              onPress={() => {
                setSelectedHairColor(color);
                setTimeout(goToNextSlide, 300);
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );

  // Slide 11: Eye Color selection
  const eyeColorOptions = ['Brown', 'Blue', 'Green', 'Hazel', 'Gray', 'Amber', 'Other'];
  const EyeColorSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>What color are your eyes?</Text>
        <View style={globalStyles.pillContainer}>
          {eyeColorOptions.map(color => (
            <Chip
              key={color}
              label={color}
              selected={selectedEyeColor === color}
              onPress={() => {
                setSelectedEyeColor(color);
                setTimeout(goToNextSlide, 300);
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );

  // Slide 12: Body Type selection (matches BodyTypesScreen options)
  const bodyTypes = [

    {name: 'Inverted Triangle', emoji: '🔻'},
    {name: 'Triangle (Pear)', emoji:  '🔺'},
    {name: 'Rectangle', emoji: '▭'},
    {name: 'Oval (Apple)', emoji: '⬭'},
    {name: 'Hourglass', emoji: '⏳'},
  ];
  const BodyTypeSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>What body type do you have?</Text>
        <View style={styles.bodyTypeGrid}>
          {bodyTypes.map(item => (
            <TouchableOpacity
              key={item.name}
              style={[
                styles.bodyTypeCard,
                selectedBodyType === item.name && styles.bodyTypeCardSelected,
              ]}
              onPress={() => {
                setSelectedBodyType(item.name);
                setTimeout(goToNextSlide, 300);
              }}>
              <Text style={styles.bodyTypeEmoji}>{item.emoji}</Text>
              <Text style={styles.bodyTypeLabel}>{item.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );

  // Slide: Personality Traits
  const personalityTraits = [
    'Confident',
    'Adventurous',
    'Laid-back',
    'Creative',
    'Bold',
    'Playful',
    'Chill',
  ];
  const PersonalityTraitsSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>
          What are your Personality Traits?
        </Text>
        <View style={styles.chipContainer}>
          {personalityTraits.map(trait => (
            <TouchableOpacity
              key={trait}
              style={[
                styles.chip,
                selectedPersonalityTraits.includes(trait) &&
                  styles.chipSelected,
              ]}
              onPress={() => {
                setSelectedPersonalityTraits(prev =>
                  prev.includes(trait)
                    ? prev.filter(t => t !== trait)
                    : [...prev, trait],
                );
              }}>
              <Text
                style={[
                  styles.chipText,
                  selectedPersonalityTraits.includes(trait) &&
                    styles.chipTextSelected,
                ]}>
                {trait}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <View style={styles.bottomButtonContainer}>
        <TouchableOpacity style={styles.primaryButton} onPress={goToNextSlide}>
          <Text style={styles.primaryButtonText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Slide 13: Height & Weight
  const HeightWeightSlideElement = (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>Height & Weight</Text>

        {/* Height Section */}
        <Text style={[styles.label, {marginTop: 16}]}>Height</Text>
        <View style={styles.unitToggleContainer}>
          <TouchableOpacity
            style={[
              styles.unitToggle,
              heightUnit === 'ft'
                ? styles.unitToggleActive
                : styles.unitToggleInactive,
            ]}
            onPress={() => setHeightUnit('ft')}>
            <Text
              style={
                heightUnit === 'ft'
                  ? styles.unitToggleTextActive
                  : styles.unitToggleTextInactive
              }>
              ft/in
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.unitToggle,
              heightUnit === 'cm'
                ? styles.unitToggleActive
                : styles.unitToggleInactive,
            ]}
            onPress={() => setHeightUnit('cm')}>
            <Text
              style={
                heightUnit === 'cm'
                  ? styles.unitToggleTextActive
                  : styles.unitToggleTextInactive
              }>
              cm
            </Text>
          </TouchableOpacity>
        </View>
        {heightUnit === 'ft' ? (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.measureInput}
              placeholder="5"
              placeholderTextColor={theme.colors.muted}
              keyboardType="numeric"
              value={heightFeet}
              onChangeText={setHeightFeet}
            />
            <Text style={styles.inputLabel}>ft</Text>
            <TextInput
              style={[styles.measureInput, {marginLeft: 16}]}
              placeholder="10"
              placeholderTextColor={theme.colors.muted}
              keyboardType="numeric"
              value={heightInches}
              onChangeText={setHeightInches}
            />
            <Text style={styles.inputLabel}>in</Text>
          </View>
        ) : (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.measureInput}
              placeholder="178"
              placeholderTextColor={theme.colors.muted}
              keyboardType="numeric"
              value={heightCm}
              onChangeText={setHeightCm}
            />
            <Text style={styles.inputLabel}>cm</Text>
          </View>
        )}

        {/* Weight Section */}
        <Text style={[styles.label, {marginTop: 8}]}>Weight</Text>
        <View style={styles.unitToggleContainer}>
          <TouchableOpacity
            style={[
              styles.unitToggle,
              weightUnit === 'lbs'
                ? styles.unitToggleActive
                : styles.unitToggleInactive,
            ]}
            onPress={() => setWeightUnit('lbs')}>
            <Text
              style={
                weightUnit === 'lbs'
                  ? styles.unitToggleTextActive
                  : styles.unitToggleTextInactive
              }>
              lbs
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.unitToggle,
              weightUnit === 'kg'
                ? styles.unitToggleActive
                : styles.unitToggleInactive,
            ]}
            onPress={() => setWeightUnit('kg')}>
            <Text
              style={
                weightUnit === 'kg'
                  ? styles.unitToggleTextActive
                  : styles.unitToggleTextInactive
              }>
              kg
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.measureInput}
            placeholder={weightUnit === 'lbs' ? '160' : '73'}
            placeholderTextColor={theme.colors.muted}
            keyboardType="numeric"
            value={weight}
            onChangeText={setWeight}
          />
          <Text style={styles.inputLabel}>{weightUnit}</Text>
        </View>

        {/* <Text style={styles.inputNote}>
          This helps us provide more accurate style recommendations for your
          body type.
        </Text> */}

        <TouchableOpacity
          style={styles.fillLaterButton}
          onPress={goToNextSlide}>
          <Text style={styles.fillLaterText}>Fill in later</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.bottomButtonContainer}>
        <TouchableOpacity style={styles.primaryButton} onPress={goToNextSlide}>
          <Text style={styles.primaryButtonText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Slide 14: Go-to Styles (matches PreferencesScreen options)
  const styleOptions = [
    {name: 'Minimalist', image: require('../assets/images/free1.jpg')},
    {name: 'Streetwear', image: require('../assets/images/headshot-3.jpg')},
    {name: 'Formal', image: require('../assets/images/headshot-1.webp')},
    {name: 'Luxury', image: require('../assets/images/headshot-2.webp')},
    {name: 'Bohemian', image: require('../assets/images/headshot-5.jpg')},
    {name: 'Preppy', image: require('../assets/images/free1.jpg')},
    {name: 'Sporty', image: require('../assets/images/free1.jpg')},
    {name: 'Vintage', image: require('../assets/images/free1.jpg')},
    {name: 'Trendy', image: require('../assets/images/free1.jpg')},
    {name: 'Business Casual', image: require('../assets/images/headshot-1.webp')},
    {name: 'Classic', image: require('../assets/images/free1.jpg')},
    {name: 'Edgy', image: require('../assets/images/free1.jpg')},
    {name: 'Artsy', image: require('../assets/images/free1.jpg')},
    {name: 'Elegant', image: require('../assets/images/free1.jpg')},
  ];
  const StylesSlide = () => {
    const toggleStyle = (styleName: string) => {
      setSelectedStyles(prev =>
        prev.includes(styleName)
          ? prev.filter(s => s !== styleName)
          : [...prev, styleName],
      );
    };

    return (
      <View style={styles.onboardingContainer}>
        <View style={styles.onboardingHeader}>
          <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.onboardingContent}
          showsVerticalScrollIndicator={false}>
          <Text style={styles.onboardingTitle}>
            What is your style?
          </Text>
          <Text style={[styles.inputNote, {marginBottom: 20}]}>
            Select all that apply
          </Text>
          <View style={styles.styleGrid}>
            {styleOptions.map(item => (
              <TouchableOpacity
                key={item.name}
                style={styles.styleCard}
                onPress={() => toggleStyle(item.name)}>
                <View
                  style={[
                    styles.styleImageContainer,
                    selectedStyles.includes(item.name) &&
                      styles.styleImageContainerSelected,
                  ]}>
                  <Image
                    source={item.image}
                    style={styles.styleImage}
                    resizeMode="cover"
                  />
                </View>
                <Text style={styles.styleLabel}>{item.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={
              selectedStyles.length > 0
                ? styles.primaryButton
                : styles.primaryButtonDisabled
            }
            onPress={goToNextSlide}>
            <Text
              style={
                selectedStyles.length > 0
                  ? styles.primaryButtonText
                  : styles.primaryButtonTextDisabled
              }>
              Next
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Slide 15: Budget Range (matches BudgetAndBrandsScreen)
  const [budgetMinInput, setBudgetMinInput] = useState('');
  const [budgetMaxInput, setBudgetMaxInput] = useState('');
  const [budgetMin, setBudgetMin] = useState<number | null>(null);
  const [budgetMax, setBudgetMax] = useState<number | null>(null);
  const handleBudgetMinChange = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, '');
    const numeric = parseInt(cleaned || '0');
    setBudgetMinInput(cleaned ? `$${numeric.toLocaleString()}` : '');
    setBudgetMin(cleaned ? numeric : null);
  };
  const handleBudgetMaxChange = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, '');
    const numeric = parseInt(cleaned || '0');
    setBudgetMaxInput(cleaned ? `$${numeric.toLocaleString()}` : '');
    setBudgetMax(cleaned ? numeric : null);
  };
  const PriceRangeSlideElement = (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>Your Monthly Style Budget</Text>
        <Text style={[styles.inputNote, {marginBottom: 20}]}>
          This helps us suggest brands that match your budget
        </Text>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 12}}>
          <View style={{flex: 1}}>
            <Text
              style={{
                color: theme.colors.muted,
                fontSize: 13,
                marginBottom: 6,
              }}>
              Min
            </Text>
            <TextInput
              placeholder="$ Min"
              placeholderTextColor={theme.colors.muted}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: 12,
                padding: 16,
                fontSize: 18,
                backgroundColor: theme.colors.surface3,
                color: theme.colors.foreground,
              }}
              keyboardType="numeric"
              value={budgetMinInput}
              onChangeText={handleBudgetMinChange}
            />
          </View>
          <Text
            style={{
              color: theme.colors.muted,
              fontSize: 16,
              marginTop: 20,
            }}>
            –
          </Text>
          <View style={{flex: 1}}>
            <Text
              style={{
                color: theme.colors.muted,
                fontSize: 13,
                marginBottom: 6,
              }}>
              Max
            </Text>
            <TextInput
              placeholder="$ Max"
              placeholderTextColor={theme.colors.muted}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: 12,
                padding: 16,
                fontSize: 18,
                backgroundColor: theme.colors.surface3,
                color: theme.colors.foreground,
              }}
              keyboardType="numeric"
              value={budgetMaxInput}
              onChangeText={handleBudgetMaxChange}
            />
          </View>
        </View>
      </View>
      <View style={styles.bottomButtonContainer}>
        <TouchableOpacity
          style={
            budgetMinInput || budgetMaxInput
              ? styles.primaryButton
              : styles.primaryButtonDisabled
          }
          onPress={goToNextSlide}>
          <Text
            style={
              budgetMinInput || budgetMaxInput
                ? styles.primaryButtonText
                : styles.primaryButtonTextDisabled
            }>
            Next
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Shopping Priorities slide (matches FitPreferencesScreen options)
  const shoppingPriorityOptions = [
    'Slim Fit',
    'Relaxed Fit',
    'Tailored',
    'Boxy',
    'Skinny',
    'Oversized',
  ];
  const ShoppingPrioritiesSlide = () => {
    const togglePriority = (priority: string) => {
      setSelectedShoppingPriorities(prev =>
        prev.includes(priority)
          ? prev.filter(p => p !== priority)
          : [...prev, priority],
      );
    };

    return (
      <View style={styles.onboardingContainer}>
        <View style={styles.onboardingHeader}>
          <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.onboardingContent}>
          <Text style={styles.onboardingTitle}>
            What type of fit do you mostly prefer?
          </Text>
          <Text style={[styles.inputNote, {marginBottom: 16}]}>
            Select all that apply
          </Text>
          <View style={styles.chipContainer}>
            {shoppingPriorityOptions.map(option => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.chip,
                  selectedShoppingPriorities.includes(option) &&
                    styles.chipSelected,
                ]}
                onPress={() => togglePriority(option)}>
                <Text
                  style={
                    selectedShoppingPriorities.includes(option)
                      ? styles.chipTextSelected
                      : styles.chipText
                  }>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={
              selectedShoppingPriorities.length > 0
                ? styles.primaryButton
                : styles.primaryButtonDisabled
            }
            onPress={goToNextSlide}>
            <Text
              style={
                selectedShoppingPriorities.length > 0
                  ? styles.primaryButtonText
                  : styles.primaryButtonTextDisabled
              }>
              Next
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Clothing Types slide
  const clothingTypeOptions = [
    'Casual',
    'Business casual',
    'Night out',
    'Active',
    'Leisure',
    'Special occasions',
  ];
  const ClothingTypesSlide = () => {
    const toggleType = (type: string) => {
      setSelectedClothingTypes(prev =>
        prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type],
      );
    };

    return (
      <View style={styles.onboardingContainer}>
        <View style={styles.onboardingHeader}>
          <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.onboardingContent}>
          <Text style={styles.onboardingTitle}>
            What types of clothes are you looking for?
          </Text>
          <Text style={[styles.inputNote, {marginBottom: 16}]}>
            Select all that apply
          </Text>
          <View style={styles.chipContainer}>
            {clothingTypeOptions.map(option => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.chip,
                  selectedClothingTypes.includes(option) && styles.chipSelected,
                ]}
                onPress={() => toggleType(option)}>
                <Text
                  style={
                    selectedClothingTypes.includes(option)
                      ? styles.chipTextSelected
                      : styles.chipText
                  }>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={
              selectedClothingTypes.length > 0
                ? styles.primaryButton
                : styles.primaryButtonDisabled
            }
            onPress={goToNextSlide}>
            <Text
              style={
                selectedClothingTypes.length > 0
                  ? styles.primaryButtonText
                  : styles.primaryButtonTextDisabled
              }>
              Next
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Simple Height slide
  const SimpleHeightSlide = () => (
    <View style={styles.onboardingContainer}>
      <View style={styles.onboardingHeader}>
        <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.onboardingContent}>
        <Text style={styles.onboardingTitle}>How tall are you?</Text>
        <View style={styles.simpleHeightRow}>
          <TextInput
            style={styles.simpleHeightInput}
            placeholder="5"
            placeholderTextColor={theme.colors.muted}
            keyboardType="numeric"
            maxLength={1}
            value={simpleHeightFeet}
            onChangeText={setSimpleHeightFeet}
          />
          <Text style={styles.simpleHeightLabel}>Ft</Text>
          <TextInput
            style={styles.simpleHeightInput}
            placeholder="10"
            placeholderTextColor={theme.colors.muted}
            keyboardType="numeric"
            maxLength={2}
            value={simpleHeightInches}
            onChangeText={setSimpleHeightInches}
          />
          <Text style={styles.simpleHeightLabel}>In</Text>
        </View>
      </View>
      <View style={styles.bottomButtonContainer}>
        <TouchableOpacity
          style={
            simpleHeightFeet || simpleHeightInches
              ? styles.primaryButton
              : styles.primaryButtonDisabled
          }
          onPress={goToNextSlide}>
          <Text
            style={
              simpleHeightFeet || simpleHeightInches
                ? styles.primaryButtonText
                : styles.primaryButtonTextDisabled
            }>
            Next
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Sizes slide with expandable sections
  const sizeCategories = [
    {
      key: 'shirt',
      label: 'Shirt',
      sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
    },
    {
      key: 'waist',
      label: 'Waist',
      sizes: ['28', '30', '32', '34', '36', '38', '40'],
    },
    {key: 'inseam', label: 'Inseam', sizes: ['28', '30', '32', '34', '36']},
    {
      key: 'blazer',
      label: 'Blazer',
      sizes: ['36', '38', '40', '42', '44', '46'],
    },
    {
      key: 'shoe',
      label: 'Shoe',
      sizes: ['7', '8', '9', '10', '11', '12', '13'],
    },
  ];
  const fitOptions = ['Too small', 'Just right', 'Too big'];

  const SizesSlide = () => {
    const updateSize = (category: string, size: string) => {
      setSizes(prev => ({
        ...prev,
        [category]: {...prev[category as keyof typeof prev], size},
      }));
    };

    const updateFit = (category: string, fit: string) => {
      setSizes(prev => ({
        ...prev,
        [category]: {...prev[category as keyof typeof prev], fit},
      }));
    };

    const getSizeDisplay = (category: {key: string; label: string}) => {
      const sizeData = sizes[category.key as keyof typeof sizes];
      if (sizeData.size) {
        return sizeData.fit
          ? `${sizeData.size} - ${sizeData.fit}`
          : sizeData.size;
      }
      return '';
    };

    return (
      <View style={styles.onboardingContainer}>
        <View style={styles.onboardingHeader}>
          <TouchableOpacity style={styles.backButton} onPress={goToPrevSlide}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipButton} onPress={goToNextSlide}>
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.onboardingContent}
          showsVerticalScrollIndicator={false}>
          <Text style={styles.onboardingTitle}>What are your sizes?</Text>
          <Text style={[styles.inputNote, {marginBottom: 20}]}>
            This helps us find clothes that fit
          </Text>
          {sizeCategories.map(category => (
            <View key={category.key} style={styles.expandableSection}>
              <TouchableOpacity
                style={styles.expandableHeader}
                onPress={() =>
                  setExpandedSizeSection(
                    expandedSizeSection === category.key ? null : category.key,
                  )
                }>
                <View>
                  <Text style={styles.expandableTitle}>{category.label}</Text>
                  {getSizeDisplay(category) ? (
                    <Text style={styles.expandableValue}>
                      {getSizeDisplay(category)}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.expandableChevron}>
                  {expandedSizeSection === category.key ? '▲' : '▼'}
                </Text>
              </TouchableOpacity>
              {expandedSizeSection === category.key && (
                <View style={styles.expandableContent}>
                  <View style={styles.sizeChipContainer}>
                    {category.sizes.map(size => (
                      <TouchableOpacity
                        key={size}
                        style={[
                          styles.sizeChip,
                          sizes[category.key as keyof typeof sizes].size ===
                            size && styles.sizeChipSelected,
                        ]}
                        onPress={() => updateSize(category.key, size)}>
                        <Text
                          style={
                            sizes[category.key as keyof typeof sizes].size ===
                            size
                              ? styles.sizeChipTextSelected
                              : styles.sizeChipText
                          }>
                          {size}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {sizes[category.key as keyof typeof sizes].size && (
                    <>
                      <Text style={styles.fitLabel}>
                        This size tends to run:
                      </Text>
                      <View style={styles.fitOptionContainer}>
                        {fitOptions.map(fit => (
                          <TouchableOpacity
                            key={fit}
                            style={[
                              styles.fitOption,
                              sizes[category.key as keyof typeof sizes].fit ===
                                fit && styles.fitOptionSelected,
                            ]}
                            onPress={() => updateFit(category.key, fit)}>
                            <Text
                              style={
                                sizes[category.key as keyof typeof sizes]
                                  .fit === fit
                                  ? styles.fitOptionTextSelected
                                  : styles.fitOptionText
                              }>
                              {fit}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}
                </View>
              )}
            </View>
          ))}
        </ScrollView>
        <View style={styles.bottomButtonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={goToNextSlide}>
            <Text style={styles.primaryButtonText}>Next</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const GetStarted = () => (
    <View style={[styles.panel, {backgroundColor: theme.colors.surface}]}>
      <View
        style={{
          backgroundColor: theme.colors.surface3,
          borderRadius: 16,
          padding: 24,
          marginTop: 340,
          marginBottom: 40,
          marginHorizontal: 24,
        }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 22,
            fontWeight: '700',
            textAlign: 'center',
            marginBottom: 16,
          }}>
          Don't Wait! 😊
        </Text>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 16,
            textAlign: 'center',
            lineHeight: 24,
          }}>
          Go to <Text style={{fontWeight: '700'}}>Profile</Text> {'>'}{' '}
          <Text style={{fontWeight: '700'}}>"Edit Style Profile"</Text> to
          finish filling out your personalized Style Profile to get the best
          recommendations and results from StylHelpr!
        </Text>
      </View>

      <TouchableOpacity
        onPress={() => navigate('Home')}
        style={{
          backgroundColor: theme.colors.button1,
          paddingVertical: 16,
          paddingHorizontal: 48,
          borderRadius: 14,
        }}>
        <Text
          style={{
            color: theme.colors.buttonText1,
            fontSize: 18,
            fontWeight: '600',
          }}>
          Enter StylHelpr
        </Text>
      </TouchableOpacity>
    </View>
  );

  const slides = [
    // Screen 1 - Welcome (KEEP)
    {
      key: '1',
      element: (
        <Step
          title="Welcome to StylHelpr. You're going to love how you look!"
          description=""
          image={require('../assets/images/landing-page28.jpg')}
        />
      ),
    },
    // Screen 2 - Feature: Closet
    {
      key: '2',
      element: <ClosetFeatureSlide />,
    },
    // Screen 3 - Feature: AI Stylist
    {
      key: '3',
      element: <AIStylistFeatureSlide />,
    },
    // Screen 4 - Feature: AI Cleanup
    {
      key: '4',
      element: <AICleanupFeatureSlide />,
    },
    // Screen 5 - Feature: Calendar
    {
      key: '5',
      element: <CalendarFeatureSlide />,
    },
    // Screen 6 - Feature: Community
    {
      key: '5b',
      element: <CommunityFeatureSlide />,
    },
    // Screen 7 - Feature: Trends
    {
      key: '5c',
      element: <TrendsFeatureSlide />,
    },
    // Screen 8 - Feature: Shopping
    {
      key: '5d',
      element: <ShoppingFeatureSlide />,
    },
    // Screen 9 - Feature: Weather
    {
      key: '5e',
      element: <WeatherFeatureSlide />,
    },
    // Screen 10 - Get to know you intro
    {
      key: '6',
      element: <GetToKnowYouSlide />,
    },
    // Screen 7 - Shopping Priorities (NEW)
    {
      key: '7',
      element: <ShoppingPrioritiesSlide />,
    },
    // Screen 8 - Sizes (NEW)
    {
      key: '10',
      element: <SizesSlide />,
    },
    // Screen 11 - Location selection
    {
      key: '12',
      element: <LocationSlide />,
    },
    // Screen 12 - Hair Color
    {
      key: '14',
      element: <HairColorSlide />,
    },
    // Screen 15 - Eye Color
    {
      key: '15',
      element: <EyeColorSlide />,
    },
    // Screen 16 - Body Type
    {
      key: '16',
      element: <BodyTypeSlide />,
    },
    // Screen 16.25 - Favorite Brands
    {
      key: '16.25',
      element: FavoriteBrandsSlideElement,
    },
    // Screen 16.5 - Personality Traits
    {
      key: '16.5',
      element: <PersonalityTraitsSlide />,
    },
    // Screen 17 - Height & Weight
    {
      key: '17',
      element: HeightWeightSlideElement,
    },
    // Screen 18 - Go-to Styles
    {
      key: '18',
      element: <StylesSlide />,
    },
    // Screen 19 - Price Range / Brands
    {
      key: '19',
      element: PriceRangeSlideElement,
    },
    // Screen 20 - Profile Form
    {
      key: '20',
      element: OldFormSlide,
    },
    // Screen 21 - Get Started (KEEP - last)
    {key: '21', element: <GetStarted />},
  ];

  // Bottom dots removed - feature slides have their own internal dots

  // ------------------------
  // RENDER
  // ------------------------

  if (!ready) return null; // ← FIX: Prevent premature mount

  return (
    <View style={{flex: 1}}>
      <FlatList
        ref={flatListRef}
        horizontal
        pagingEnabled
        data={slides}
        keyExtractor={item => item.key}
        renderItem={({item}) => item.element}
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={0}
        scrollEnabled={scrollEnabled}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        windowSize={21}
        initialNumToRender={17}
        maxToRenderPerBatch={17}
        getItemLayout={(data, index) => ({
          length: width,
          offset: width * index,
          index,
        })}
        onScroll={Animated.event(
          [{nativeEvent: {contentOffset: {x: scrollX}}}],
          {useNativeDriver: false},
        )}
        onMomentumScrollEnd={e => {
          const index = Math.round(e.nativeEvent.contentOffset.x / width);
          setCurrentIndex(index);
        }}
        scrollEventThrottle={16}
      />
      {/* Fixed dots and Next button for first 9 slides */}
      {currentIndex < 9 && (
        <View style={styles.fixedBottomContainer}>
          <View style={styles.featureDotsContainer}>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (
              <View
                key={i}
                style={[
                  styles.featureDot,
                  currentIndex === i
                    ? styles.featureDotActive
                    : styles.featureDotInactive,
                ]}
              />
            ))}
          </View>
          <TouchableOpacity
            style={styles.featureButton}
            onPress={goToNextSlide}>
            <Text style={styles.featureButtonText}>Next</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

////////////////

// // // screens/OnboardingScreen.tsx
// import React, {useRef, useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   StyleSheet,
//   Dimensions,
//   FlatList,
//   Animated,
//   TextInput,
//   TouchableOpacity,
//   ScrollView,
//   ActivityIndicator,
//   Modal,
//   TouchableWithoutFeedback,
// } from 'react-native';

// import * as Animatable from 'react-native-animatable';
// import {Picker} from '@react-native-picker/picker';
// import {useAppTheme} from '../context/ThemeContext';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';

// type Props = {navigate: (screen: string, params?: any) => void};

// const {width} = Dimensions.get('window');
// const ONBOARDING_KEY = 'stylhelpr_onboarding_complete';

// export default function OnboardingScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const userId = useUUID();

//   const scrollX = useRef(new Animated.Value(0)).current;
//   const flatListRef = useRef(null);

//   const [index, setIndex] = useState(0);
//   const [scrollEnabled, setScrollEnabled] = useState(true);

//   // NEW → Required to prevent FlatList jumping to slide 6
//   const [ready, setReady] = useState(false);
//   useEffect(() => {
//     requestAnimationFrame(() => setReady(true));
//   }, []);

//   // ------------------------
//   // OLD FORM STATE
//   // ------------------------
//   const [saving, setSaving] = useState(false);
//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   const [showFashionPicker, setShowFashionPicker] = useState(false);
//   const [showGenderPicker, setShowGenderPicker] = useState(false);

//   const handleChange = (field, val) => {
//     setForm(prev => ({...prev, [field]: val}));
//   };

//   const normalizeGender = s => s.trim().toLowerCase().replace(/\s+/g, '_');

//   const buildPayload = () => {
//     const payload = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       const trimmed = typeof v === 'string' ? v.trim() : v;
//       if (trimmed) payload[k] = trimmed;
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async token => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({}));
//         id = prof?.id || prof?.uuid || null;
//       } catch {}
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token);
//       const payload = buildPayload();

//       if (id && token) {
//         await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT',
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });
//       }

//       // Mark onboarding complete
//       await AsyncStorage.setItem('onboarding_complete', 'true');

//       // 👇 NEW: go to the LAST CARD (index 6)
//       requestAnimationFrame(() => {
//         flatListRef.current?.scrollToIndex({
//           index: 6,
//           animated: true,
//         });
//       });
//     } catch (err) {
//       await AsyncStorage.setItem('onboarding_complete', 'true');

//       // still go to last card even if the request fails
//       requestAnimationFrame(() => {
//         flatListRef.current?.scrollToIndex({
//           index: 6,
//           animated: true,
//         });
//       });
//     } finally {
//       setSaving(false);
//     }
//   };

//   // ------------------------
//   // OLD FORM SLIDE
//   // ------------------------
//   const OldFormSlide = (
//     <ScrollView
//       keyboardShouldPersistTaps="handled"
//       style={[styles.formContainer, {backgroundColor: theme.colors.surface}]}>
//       <Animatable.View
//         animation="fadeInUp"
//         duration={600}
//         style={[styles.card, {backgroundColor: theme.colors.surface}]}>
//         <Text style={[styles.title, {color: theme.colors.button1}]}>
//           Welcome to StylHelprfghfgh
//         </Text>

//         <Text style={styles.label}>Firstfgh Name</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter first name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.first_name}
//           onChangeText={val => handleChange('first_name', val)}
//         />

//         <Text style={styles.label}>Last Namedfg</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter last name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.last_name}
//           onChangeText={val => handleChange('last_name', val)}
//         />

//         <Text style={styles.label}>Profession</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter profession"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.profession}
//           onChangeText={val => handleChange('profession', val)}
//         />

//         <Text style={styles.label}>Fashion Levelsddsf</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowFashionPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.fashion_level || 'Select fashion level'}
//           </Text>
//         </TouchableOpacity>

//         <Text style={styles.label}>Gender Presentation</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowGenderPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.gender_presentation || 'Select gender presentation'}
//           </Text>
//         </TouchableOpacity>

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={[styles.button, {backgroundColor: theme.colors.button1}]}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* FASHION PICKER MODAL */}
//       <Modal visible={showFashionPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowFashionPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
//             <View style={styles.sheetToolbar}>
//               <TouchableOpacity onPress={() => setShowFashionPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.fashion_level}
//               onValueChange={val => handleChange('fashion_level', val)}>
//               <Picker.Item label="Select fashion level" value="" />
//               <Picker.Item label="Expert" value="Expert" />
//               <Picker.Item label="Intermediate" value="Intermediate" />
//               <Picker.Item label="Novice" value="Novice" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>

//       {/* GENDER PICKER MODAL */}
//       <Modal visible={showGenderPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowGenderPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
//             <View style={styles.sheetToolbar}>
//               <TouchableOpacity onPress={() => setShowGenderPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.gender_presentation}
//               onValueChange={val => handleChange('gender_presentation', val)}>
//               <Picker.Item label="Select gender presentation" value="" />
//               <Picker.Item label="Male" value="Male" />
//               <Picker.Item label="Female" value="Female" />
//               <Picker.Item label="Other" value="Other" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>
//     </ScrollView>
//   );

//   // ------------------------
//   // CARDS
//   // ------------------------
//   const Step = ({title, description, image}) => (
//     <View style={[styles.panel, {backgroundColor: theme.colors.surface}]}>
//       <Image source={image} style={styles.stepImage} />
//       <Text style={[styles.stepTitle, {color: theme.colors.foreground}]}>
//         {title}
//       </Text>
//       <Text style={[styles.stepDescription, {color: theme.colors.foreground}]}>
//         {description}
//       </Text>
//     </View>
//   );

//   //   const handleSave = async () => {
//   //     if (saving) return;
//   //     setSaving(true);

//   //     try {
//   //       const token = await getAccessToken();
//   //       const id = await resolveUserId(token || null);
//   //       const payload = buildPayload();

//   //       if (id && token) {
//   //         await fetch(`${API_BASE_URL}/users/${id}`, {
//   //           method: 'PUT',
//   //           headers: {
//   //             'Content-Type': 'application/json',
//   //             Authorization: `Bearer ${token}`,
//   //           },
//   //           body: JSON.stringify(payload),
//   //         });
//   //       }

//   //       await AsyncStorage.setItem('onboarding_complete', 'true');
//   //       navigate('Home');
//   //     } catch (err) {
//   //       await AsyncStorage.setItem('onboarding_complete', 'true');
//   //       navigate('Home');
//   //     } finally {
//   //       setSaving(false);
//   //     }
//   //   };

//   const GetStarted = () => (
//     <View style={[styles.panel, {backgroundColor: theme.colors.surface}]}>
//       <Text style={[styles.stepTitle, {color: theme.colors.foreground}]}>
//         You're all set!
//       </Text>

//       <TouchableOpacity onPress={() => navigate('Home')}>
//         <View
//           style={[
//             styles.button,
//             {backgroundColor: theme.colors.button1, width: 200},
//           ]}>
//           <Text style={{color: theme.colors.buttonText1, fontSize: 18}}>
//             Let's Get Started
//           </Text>
//         </View>
//       </TouchableOpacity>
//     </View>
//   );

//   const slides = [
//     {
//       key: '1',
//       element: (
//         <Step
//           title="Welcome to StylHelpr"
//           description="StylHelpr analyzes your wardrobe."
//           image={require('../assets/images/free1.jpg')}
//         />
//       ),
//     },
//     {
//       key: '2',
//       element: (
//         <Step
//           title="AI-Powered Fits"
//           description="The AI stylist creates outfits tailored to you."
//           image={require('../assets/images/headshot-1.webp')}
//         />
//       ),
//     },
//     {
//       key: '3',
//       element: (
//         <Step
//           title="Daily Inspiration"
//           description="Fresh outfit ideas, every day."
//           image={require('../assets/images/headshot-3.jpg')}
//         />
//       ),
//     },
//     {
//       key: '4',
//       element: (
//         <Step
//           title="Travel Mode"
//           description="Packing suggestions based on weather."
//           image={require('../assets/images/headshot-2.webp')}
//         />
//       ),
//     },
//     {
//       key: '5',
//       element: (
//         <Step
//           title="Your Style Profile"
//           description="Help the AI understand your preferences."
//           image={require('../assets/images/headshot-5.jpg')}
//         />
//       ),
//     },

//     {key: '6', element: OldFormSlide},

//     {key: '7', element: <GetStarted />},
//   ];

//   const DotIndicator = () => (
//     <View style={styles.dotsContainer}>
//       {slides.map((_, i) => {
//         const inputRange = [(i - 1) * width, i * width, (i + 1) * width];

//         const dotWidth = scrollX.interpolate({
//           inputRange,
//           outputRange: [8, 24, 8],
//           extrapolate: 'clamp',
//         });

//         return (
//           <Animated.View
//             key={i}
//             style={[
//               styles.dot,
//               {
//                 width: dotWidth,
//                 backgroundColor:
//                   i === index
//                     ? theme.colors.primary
//                     : theme.colors.button1 + '55',
//               },
//             ]}
//           />
//         );
//       })}
//     </View>
//   );

//   // ------------------------
//   // RENDER
//   // ------------------------

//   if (!ready) return null; // ← FIX: Prevent premature mount

//   return (
//     <View style={{flex: 1}}>
//       <FlatList
//         ref={flatListRef}
//         horizontal
//         pagingEnabled
//         data={slides}
//         keyExtractor={item => item.key}
//         renderItem={({item}) => item.element}
//         showsHorizontalScrollIndicator={false}
//         initialScrollIndex={0}
//         scrollEnabled={scrollEnabled}
//         getItemLayout={(data, index) => ({
//           length: width,
//           offset: width * index,
//           index,
//         })}
//         onScroll={Animated.event(
//           [{nativeEvent: {contentOffset: {x: scrollX}}}],
//           {useNativeDriver: false},
//         )}
//         scrollEventThrottle={16}
//       />

//       <DotIndicator />
//     </View>
//   );
// }

// // -----------------------------------------------------
// // STYLES
// // -----------------------------------------------------
// const styles = StyleSheet.create({
//   panel: {
//     width,
//     padding: 24,
//     alignItems: 'center',
//     justifyContent: 'center',
//   },

//   stepImage: {
//     width: width * 0.75,
//     height: width * 0.75,
//     borderRadius: 20,
//     marginBottom: 40,
//   },

//   stepTitle: {
//     fontSize: 28,
//     fontWeight: '700',
//   },

//   stepDescription: {
//     fontSize: 17,
//     textAlign: 'center',
//     opacity: 0.7,
//     paddingHorizontal: 20,
//     marginTop: 20,
//   },

//   formContainer: {
//     width,
//     paddingTop: 40,
//   },
//   card: {
//     padding: 20,
//     borderRadius: 20,
//     margin: 6,
//   },
//   title: {
//     fontSize: 36,
//     fontWeight: '600',
//     marginBottom: 22,
//     textAlign: 'center',
//   },
//   label: {
//     fontSize: 13,
//     fontWeight: '600',
//     marginBottom: 8,
//     textTransform: 'capitalize',
//     color: '#000',
//   },
//   input: {
//     borderRadius: 12,
//     paddingHorizontal: 14,
//     paddingVertical: 14,
//     marginBottom: 22,
//     fontSize: 15,
//     color: '#000',
//   },
//   selectorButton: {
//     borderRadius: 12,
//     paddingHorizontal: 14,
//     paddingVertical: 16,
//     marginBottom: 22,
//     borderWidth: 1,
//   },
//   selectorText: {
//     fontSize: 15,
//   },
//   modalRoot: {
//     flex: 1,
//     justifyContent: 'flex-end',
//     backgroundColor: 'rgba(0,0,0,0.4)',
//   },
//   backdropHitArea: {flex: 1},
//   sheet: {
//     borderTopLeftRadius: 20,
//     borderTopRightRadius: 20,
//     paddingBottom: 24,
//   },
//   sheetToolbar: {
//     flexDirection: 'row',
//     justifyContent: 'flex-end',
//     padding: 12,
//     borderBottomWidth: 1,
//   },
//   button: {
//     borderRadius: 14,
//     paddingVertical: 16,
//     alignItems: 'center',
//     marginTop: 20,
//   },
//   buttonText: {
//     fontSize: 16,
//     fontWeight: '600',
//   },

//   dotsContainer: {
//     position: 'absolute',
//     bottom: 105,
//     width: '100%',
//     flexDirection: 'row',
//     justifyContent: 'center',
//   },
//   dot: {
//     height: 8,
//     marginHorizontal: 5,
//     borderRadius: 4,
//   },
// });

//////////////

// // WalthroughOnboardingScreen.tsx — FIXED: ALWAYS STARTS AT SLIDE 1
// import React, {useRef, useState, useEffect} from 'react';
// import {
//   View,
//   Text,
//   Image,
//   StyleSheet,
//   Dimensions,
//   FlatList,
//   Animated,
//   TextInput,
//   TouchableOpacity,
//   ScrollView,
//   ActivityIndicator,
//   Modal,
//   TouchableWithoutFeedback,
// } from 'react-native';

// import * as Animatable from 'react-native-animatable';
// import {Picker} from '@react-native-picker/picker';

// import {useAppTheme} from '../context/ThemeContext';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useAuth0} from 'react-native-auth0';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';

// const {width} = Dimensions.get('window');
// const ONBOARDING_KEY = 'stylhelpr_onboarding_complete';

// export default function WalthroughOnboardingScreen({navigation}) {
//   const {theme} = useAppTheme();
//   const {user} = useAuth0();
//   const userId = useUUID();

//   const scrollX = useRef(new Animated.Value(0)).current;
//   const flatListRef = useRef(null);

//   const [index, setIndex] = useState(0);
//   const [scrollEnabled, setScrollEnabled] = useState(true);

//   // NEW → Required to prevent FlatList jumping to slide 6
//   const [ready, setReady] = useState(false);
//   useEffect(() => {
//     requestAnimationFrame(() => setReady(true));
//   }, []);

//   // ------------------------
//   // OLD FORM STATE
//   // ------------------------
//   const [saving, setSaving] = useState(false);
//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   const [showFashionPicker, setShowFashionPicker] = useState(false);
//   const [showGenderPicker, setShowGenderPicker] = useState(false);

//   const handleChange = (field, val) => {
//     setForm(prev => ({...prev, [field]: val}));
//   };

//   const normalizeGender = s => s.trim().toLowerCase().replace(/\s+/g, '_');

//   const buildPayload = () => {
//     const payload = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       const trimmed = typeof v === 'string' ? v.trim() : v;
//       if (trimmed) payload[k] = trimmed;
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async token => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({}));
//         id = prof?.id || prof?.uuid || null;
//       } catch {}
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token);
//       const payload = buildPayload();

//       if (id && token) {
//         await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT',
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });
//       }

//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigation.replace('Home');
//     } catch {
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigation.replace('Home');
//     } finally {
//       setSaving(false);
//     }
//   };

//   // ------------------------
//   // OLD FORM SLIDE
//   // ------------------------
//   const OldFormSlide = (
//     <ScrollView
//       keyboardShouldPersistTaps="handled"
//       style={[styles.formContainer, {backgroundColor: theme.colors.surface}]}>
//       <Animatable.View
//         animation="fadeInUp"
//         duration={600}
//         style={[styles.card, {backgroundColor: theme.colors.surface}]}>
//         <Text style={[styles.title, {color: theme.colors.button1}]}>
//           Welcome to StylHelprfghfgh
//         </Text>

//         <Text style={styles.label}>Firstfgh Name</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter first name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.first_name}
//           onChangeText={val => handleChange('first_name', val)}
//         />

//         <Text style={styles.label}>Last Namedfg</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter last name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.last_name}
//           onChangeText={val => handleChange('last_name', val)}
//         />

//         <Text style={styles.label}>Profession</Text>
//         <TextInput
//           style={[styles.input, {backgroundColor: theme.colors.surface3}]}
//           placeholder="Enter profession"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.profession}
//           onChangeText={val => handleChange('profession', val)}
//         />

//         <Text style={styles.label}>Fashion Levelsddsf</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowFashionPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.fashion_level || 'Select fashion level'}
//           </Text>
//         </TouchableOpacity>

//         <Text style={styles.label}>Gender Presentation</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowGenderPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.gender_presentation || 'Select gender presentation'}
//           </Text>
//         </TouchableOpacity>

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={[styles.button, {backgroundColor: theme.colors.button1}]}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* FASHION PICKER MODAL */}
//       <Modal visible={showFashionPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowFashionPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
//             <View style={styles.sheetToolbar}>
//               <TouchableOpacity onPress={() => setShowFashionPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.fashion_level}
//               onValueChange={val => handleChange('fashion_level', val)}>
//               <Picker.Item label="Select fashion level" value="" />
//               <Picker.Item label="Expert" value="Expert" />
//               <Picker.Item label="Intermediate" value="Intermediate" />
//               <Picker.Item label="Novice" value="Novice" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>

//       {/* GENDER PICKER MODAL */}
//       <Modal visible={showGenderPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowGenderPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={[styles.sheet, {backgroundColor: theme.colors.surface}]}>
//             <View style={styles.sheetToolbar}>
//               <TouchableOpacity onPress={() => setShowGenderPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.gender_presentation}
//               onValueChange={val => handleChange('gender_presentation', val)}>
//               <Picker.Item label="Select gender presentation" value="" />
//               <Picker.Item label="Male" value="Male" />
//               <Picker.Item label="Female" value="Female" />
//               <Picker.Item label="Other" value="Other" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>
//     </ScrollView>
//   );

//   // ------------------------
//   // CARDS
//   // ------------------------
//   const Step = ({title, description, image}) => (
//     <View style={[styles.panel, {backgroundColor: theme.colors.surface}]}>
//       <Image source={image} style={styles.stepImage} />
//       <Text style={[styles.stepTitle, {color: theme.colors.foreground}]}>
//         {title}
//       </Text>
//       <Text style={[styles.stepDescription, {color: theme.colors.foreground}]}>
//         {description}
//       </Text>
//     </View>
//   );

//   const GetStarted = (
//     <View style={[styles.panel, {backgroundColor: theme.colors.surface}]}>
//       <Text style={[styles.stepTitle, {color: theme.colors.foreground}]}>
//         You're all set!
//       </Text>

//       <AppleTouchFeedback onPress={() => navigation.replace('HomeScreen')}>
//         <View
//           style={[
//             styles.button,
//             {backgroundColor: theme.colors.button1, width: 200},
//           ]}>
//           <Text style={{color: theme.colors.buttonText1, fontSize: 18}}>
//             Let's Get Started
//           </Text>
//         </View>
//       </AppleTouchFeedback>
//     </View>
//   );

//   const slides = [
//     {
//       key: '1',
//       element: (
//         <Step
//           title="Welcome to StylHelpr"
//           description="StylHelpr analyzes your wardrobe."
//           image={require('../assets/images/free1.jpg')}
//         />
//       ),
//     },
//     {
//       key: '2',
//       element: (
//         <Step
//           title="AI-Powered Fits"
//           description="The AI stylist creates outfits tailored to you."
//           image={require('../assets/images/headshot-1.webp')}
//         />
//       ),
//     },
//     {
//       key: '3',
//       element: (
//         <Step
//           title="Daily Inspiration"
//           description="Fresh outfit ideas, every day."
//           image={require('../assets/images/headshot-3.jpg')}
//         />
//       ),
//     },
//     {
//       key: '4',
//       element: (
//         <Step
//           title="Travel Mode"
//           description="Packing suggestions based on weather."
//           image={require('../assets/images/headshot-2.webp')}
//         />
//       ),
//     },
//     {
//       key: '5',
//       element: (
//         <Step
//           title="Your Style Profile"
//           description="Help the AI understand your preferences."
//           image={require('../assets/images/headshot-5.jpg')}
//         />
//       ),
//     },

//     {key: '6', element: OldFormSlide},

//     {key: '7', element: GetStarted},
//   ];

//   const DotIndicator = () => (
//     <View style={styles.dotsContainer}>
//       {slides.map((_, i) => {
//         const inputRange = [(i - 1) * width, i * width, (i + 1) * width];

//         const dotWidth = scrollX.interpolate({
//           inputRange,
//           outputRange: [8, 24, 8],
//           extrapolate: 'clamp',
//         });

//         return (
//           <Animated.View
//             key={i}
//             style={[
//               styles.dot,
//               {
//                 width: dotWidth,
//                 backgroundColor:
//                   i === index
//                     ? theme.colors.primary
//                     : theme.colors.button1 + '55',
//               },
//             ]}
//           />
//         );
//       })}
//     </View>
//   );

//   // ------------------------
//   // RENDER
//   // ------------------------

//   if (!ready) return null; // ← FIX: Prevent premature mount

//   return (
//     <View style={{flex: 1}}>
//       <FlatList
//         ref={flatListRef}
//         horizontal
//         pagingEnabled
//         data={slides}
//         keyExtractor={item => item.key}
//         renderItem={({item}) => item.element}
//         showsHorizontalScrollIndicator={false}
//         initialScrollIndex={0}
//         scrollEnabled={scrollEnabled}
//         getItemLayout={(data, index) => ({
//           length: width,
//           offset: width * index,
//           index,
//         })}
//         onScroll={Animated.event(
//           [{nativeEvent: {contentOffset: {x: scrollX}}}],
//           {useNativeDriver: false},
//         )}
//         scrollEventThrottle={16}
//       />

//       <DotIndicator />
//     </View>
//   );
// }

// // -----------------------------------------------------
// // STYLES
// // -----------------------------------------------------
// const styles = StyleSheet.create({
//   panel: {
//     width,
//     padding: 24,
//     alignItems: 'center',
//     justifyContent: 'center',
//   },

//   stepImage: {
//     width: width * 0.75,
//     height: width * 0.75,
//     borderRadius: 20,
//     marginBottom: 40,
//   },

//   stepTitle: {
//     fontSize: 28,
//     fontWeight: '700',
//   },

//   stepDescription: {
//     fontSize: 17,
//     textAlign: 'center',
//     opacity: 0.7,
//     paddingHorizontal: 20,
//     marginTop: 20,
//   },

//   formContainer: {
//     width,
//     paddingTop: 40,
//   },
//   card: {
//     padding: 20,
//     borderRadius: 20,
//     margin: 6,
//   },
//   title: {
//     fontSize: 36,
//     fontWeight: '600',
//     marginBottom: 22,
//     textAlign: 'center',
//   },
//   label: {
//     fontSize: 13,
//     fontWeight: '600',
//     marginBottom: 8,
//     textTransform: 'capitalize',
//     color: '#000',
//   },
//   input: {
//     borderRadius: 12,
//     paddingHorizontal: 14,
//     paddingVertical: 14,
//     marginBottom: 22,
//     fontSize: 15,
//     color: '#000',
//   },
//   selectorButton: {
//     borderRadius: 12,
//     paddingHorizontal: 14,
//     paddingVertical: 16,
//     marginBottom: 22,
//     borderWidth: 1,
//   },
//   selectorText: {
//     fontSize: 15,
//   },
//   modalRoot: {
//     flex: 1,
//     justifyContent: 'flex-end',
//     backgroundColor: 'rgba(0,0,0,0.4)',
//   },
//   backdropHitArea: {flex: 1},
//   sheet: {
//     borderTopLeftRadius: 20,
//     borderTopRightRadius: 20,
//     paddingBottom: 24,
//   },
//   sheetToolbar: {
//     flexDirection: 'row',
//     justifyContent: 'flex-end',
//     padding: 12,
//     borderBottomWidth: 1,
//   },
//   button: {
//     borderRadius: 14,
//     paddingVertical: 16,
//     alignItems: 'center',
//     marginTop: 20,
//   },
//   buttonText: {
//     fontSize: 16,
//     fontWeight: '600',
//   },

//   dotsContainer: {
//     position: 'absolute',
//     bottom: 105,
//     width: '100%',
//     flexDirection: 'row',
//     justifyContent: 'center',
//   },
//   dot: {
//     height: 8,
//     marginHorizontal: 5,
//     borderRadius: 4,
//   },
// });

//////////////////

// // screens/OnboardingScreen.tsx
// import React, {useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Alert,
//   Modal,
//   TouchableWithoutFeedback,
// } from 'react-native';
// import * as Animatable from 'react-native-animatable';
// import {useAppTheme} from '../context/ThemeContext';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';
// import {Picker} from '@react-native-picker/picker';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';

// type Props = {navigate: (screen: string, params?: any) => void};

// export default function OnboardingScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const userId = useUUID();
//   const globalStyles = useGlobalStyles();
//   const [saving, setSaving] = useState(false);

//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   // Picker modal state
//   const [showFashionPicker, setShowFashionPicker] = useState(false);
//   const [showGenderPicker, setShowGenderPicker] = useState(false);

//   // Track the "latest" wheel value while scrolling; commit/close on finger lift
//   const pendingFashion = useRef<string | null>(null);
//   const pendingGender = useRef<string | null>(null);

//   const handleChange = (field: keyof typeof form, value: string) => {
//     setForm(prev => ({...prev, [field]: value}));
//   };

//   const styles = StyleSheet.create({
//     container: {flex: 1},
//     card: {
//       padding: 20,
//       borderRadius: 20,
//       shadowOpacity: 0.1,
//       shadowRadius: 8,
//       backgroundColor: theme.colors.surface,
//       margin: 6,
//     },
//     title: {
//       fontSize: 36,
//       fontWeight: '600',
//       marginBottom: 22,
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     label: {
//       fontSize: 13,
//       fontWeight: '600',
//       marginBottom: 8,
//       color: theme.colors.foreground,
//       textTransform: 'capitalize',
//     },
//     input: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 14,
//       marginBottom: 22,
//       fontSize: 15,
//       backgroundColor: theme.colors.surface3,
//       color: theme.colors.foreground,
//     },
//     selectorButton: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 16,
//       marginBottom: 22,
//       backgroundColor: theme.colors.surface3,
//       borderWidth: theme.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     selectorText: {
//       color: theme.colors.foreground,
//       fontSize: 15,
//     },
//     // Modal/backdrop/sheet
//     modalRoot: {
//       flex: 1,
//       justifyContent: 'flex-end',
//       backgroundColor: 'rgba(0,0,0,0.4)',
//     },
//     backdropHitArea: {flex: 1}, // tap to dismiss above the sheet
//     sheet: {
//       backgroundColor: theme.colors.surface,
//       borderTopLeftRadius: 20,
//       borderTopRightRadius: 20,
//       paddingBottom: 24,
//     },
//     // Save button
//     button: {
//       borderRadius: 14,
//       paddingVertical: 16,
//       alignItems: 'center',
//       marginTop: 20,
//       backgroundColor: theme.colors.button1,
//       opacity: saving ? 0.6 : 1,
//     },
//     buttonText: {
//       fontSize: 16,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//   });

//   const normalizeGender = (s: string) =>
//     s.trim().toLowerCase().replace(/\s+/g, '_');

//   const buildPayload = () => {
//     const payload: Record<string, any> = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       if (typeof v === 'string') {
//         const trimmed = v.trim();
//         if (trimmed !== '') payload[k] = trimmed;
//       }
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async (token: string | null) => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({} as any));
//         id = (prof && (prof.id || prof.uuid)) || null;
//       } catch {}
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token || null);
//       const payload = buildPayload();

//       if (id && token) {
//         await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT',
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });
//       }

//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } catch (err) {
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } finally {
//       setSaving(false);
//     }
//   };

//   return (
//     <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
//       <Animatable.View animation="fadeInUp" duration={600} style={styles.card}>
//         <Text style={[styles.title, {color: theme.colors.button1}]}>
//           Welcome to StylHelpr
//         </Text>

//         {/* First Name */}
//         <Text style={styles.label}>First Name</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter first name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.first_name}
//           onChangeText={val => handleChange('first_name', val)}
//         />

//         {/* Last Name */}
//         <Text style={styles.label}>Last Name</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter last name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.last_name}
//           onChangeText={val => handleChange('last_name', val)}
//         />

//         {/* Profession */}
//         <Text style={styles.label}>Profession</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter profession"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.profession}
//           onChangeText={val => handleChange('profession', val)}
//         />

//         {/* Fashion Level Selector */}
//         <Text style={styles.label}>Fashion Level</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowFashionPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.fashion_level || 'Select fashion level'}
//           </Text>
//         </TouchableOpacity>

//         {/* Gender Presentation Selector */}
//         <Text style={styles.label}>Gender Presentation</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowGenderPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.gender_presentation || 'Select gender presentation'}
//           </Text>
//         </TouchableOpacity>

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={styles.button}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* ───────── Fashion Picker Modal ───────── */}
//       <Modal visible={showFashionPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowFashionPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={styles.sheet}>
//             {/* Toolbar */}
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'flex-end',
//                 padding: 12,
//                 borderBottomWidth: 1,
//                 borderColor: theme.colors.surface3,
//               }}>
//               <TouchableOpacity onPress={() => setShowFashionPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             {/* Picker */}
//             <Picker
//               selectedValue={form.fashion_level}
//               onValueChange={val => handleChange('fashion_level', val)}>
//               <Picker.Item
//                 label="Select fashion level"
//                 value=""
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Expert"
//                 value="Expert"
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Intermediate"
//                 value="Intermediate"
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Novice"
//                 value="Novice"
//                 color={theme.colors.foreground}
//               />
//             </Picker>
//           </View>
//         </View>
//       </Modal>

//       {/* ───────── Gender Picker Modal ───────── */}
//       <Modal visible={showGenderPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowGenderPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={styles.sheet}>
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'flex-end',
//                 padding: 12,
//                 borderBottomWidth: 1,
//                 borderColor: theme.colors.surface3,
//               }}>
//               <TouchableOpacity onPress={() => setShowGenderPicker(false)}>
//                 <Text style={{color: theme.colors.button1, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.gender_presentation}
//               onValueChange={val => handleChange('gender_presentation', val)}>
//               <Picker.Item
//                 label="Select gender presentation"
//                 value=""
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Male"
//                 value="Male"
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Female"
//                 value="Female"
//                 color={theme.colors.foreground}
//               />
//               <Picker.Item
//                 label="Other"
//                 value="Other"
//                 color={theme.colors.foreground}
//               />
//             </Picker>
//           </View>
//         </View>
//       </Modal>
//     </ScrollView>
//   );
// }

////////////////

// // screens/OnboardingScreen.tsx
// import React, {useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Alert,
//   Modal,
//   TouchableWithoutFeedback,
// } from 'react-native';
// import * as Animatable from 'react-native-animatable';
// import {useAppTheme} from '../context/ThemeContext';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';
// import {Picker} from '@react-native-picker/picker';

// type Props = {navigate: (screen: string, params?: any) => void};

// export default function OnboardingScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const userId = useUUID();
//   const [saving, setSaving] = useState(false);

//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   // Picker modal state
//   const [showFashionPicker, setShowFashionPicker] = useState(false);
//   const [showGenderPicker, setShowGenderPicker] = useState(false);

//   // Track the "latest" wheel value while scrolling; commit/close on finger lift
//   const pendingFashion = useRef<string | null>(null);
//   const pendingGender = useRef<string | null>(null);

//   const handleChange = (field: keyof typeof form, value: string) => {
//     setForm(prev => ({...prev, [field]: value}));
//   };

//   const styles = StyleSheet.create({
//     container: {flex: 1},
//     card: {
//       padding: 20,
//       borderRadius: 20,
//       shadowOpacity: 0.1,
//       shadowRadius: 8,
//       backgroundColor: theme.colors.surface,
//       margin: 6,
//     },
//     title: {
//       fontSize: 36,
//       fontWeight: '600',
//       marginBottom: 22,
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     label: {
//       fontSize: 13,
//       fontWeight: '600',
//       marginBottom: 8,
//       color: theme.colors.foreground,
//       textTransform: 'capitalize',
//     },
//     input: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 14,
//       marginBottom: 22,
//       fontSize: 15,
//       backgroundColor: theme.colors.surface3,
//       color: theme.colors.foreground,
//     },
//     selectorButton: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 16,
//       marginBottom: 22,
//       backgroundColor: theme.colors.surface,
//       borderWidth: theme.borderWidth.md,
//       borderColor: theme.colors.buttonText1,
//     },
//     selectorText: {
//       color: theme.colors.foreground,
//       fontSize: 15,
//     },
//     // Modal/backdrop/sheet
//     modalRoot: {
//       flex: 1,
//       justifyContent: 'flex-end',
//       backgroundColor: 'rgba(0,0,0,0.4)',
//     },
//     backdropHitArea: {flex: 1}, // tap to dismiss above the sheet
//     sheet: {
//       backgroundColor: theme.colors.surface,
//       borderTopLeftRadius: 20,
//       borderTopRightRadius: 20,
//       paddingBottom: 24,
//     },
//     // Save button
//     button: {
//       borderRadius: 14,
//       paddingVertical: 16,
//       alignItems: 'center',
//       marginTop: 20,
//       backgroundColor: theme.colors.button1,
//       opacity: saving ? 0.6 : 1,
//     },
//     buttonText: {
//       fontSize: 16,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//   });

//   const normalizeGender = (s: string) =>
//     s.trim().toLowerCase().replace(/\s+/g, '_');

//   const buildPayload = () => {
//     const payload: Record<string, any> = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       if (typeof v === 'string') {
//         const trimmed = v.trim();
//         if (trimmed !== '') payload[k] = trimmed;
//       }
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async (token: string | null) => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({} as any));
//         id = (prof && (prof.id || prof.uuid)) || null;
//       } catch {}
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token || null);
//       const payload = buildPayload();

//       if (id && token) {
//         await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT',
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });
//       }

//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } catch (err) {
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } finally {
//       setSaving(false);
//     }
//   };

//   return (
//     <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
//       <Animatable.View animation="fadeInUp" duration={600} style={styles.card}>
//         <Text style={styles.title}>Welcome to StylHelpr</Text>

//         {/* First Name */}
//         <Text style={styles.label}>First Name</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter first name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.first_name}
//           onChangeText={val => handleChange('first_name', val)}
//         />

//         {/* Last Name */}
//         <Text style={styles.label}>Last Name</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter last name"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.last_name}
//           onChangeText={val => handleChange('last_name', val)}
//         />

//         {/* Profession */}
//         <Text style={styles.label}>Profession</Text>
//         <TextInput
//           style={styles.input}
//           placeholder="Enter profession"
//           placeholderTextColor={theme.colors.inputText1}
//           value={form.profession}
//           onChangeText={val => handleChange('profession', val)}
//         />

//         {/* Fashion Level Selector */}
//         <Text style={styles.label}>Fashion Level</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowFashionPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.fashion_level || 'Select fashion level'}
//           </Text>
//         </TouchableOpacity>

//         {/* Gender Presentation Selector */}
//         <Text style={styles.label}>Gender Presentation</Text>
//         <TouchableOpacity
//           activeOpacity={0.8}
//           style={styles.selectorButton}
//           onPress={() => setShowGenderPicker(true)}>
//           <Text style={styles.selectorText}>
//             {form.gender_presentation || 'Select gender presentation'}
//           </Text>
//         </TouchableOpacity>

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={styles.button}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>

//       {/* ───────── Fashion Picker Modal ───────── */}
//       <Modal visible={showFashionPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowFashionPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={styles.sheet}>
//             {/* Toolbar */}
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'flex-end',
//                 padding: 12,
//                 borderBottomWidth: 1,
//                 borderColor: theme.colors.surface3,
//               }}>
//               <TouchableOpacity onPress={() => setShowFashionPicker(false)}>
//                 <Text style={{color: theme.colors.primary, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             {/* Picker */}
//             <Picker
//               selectedValue={form.fashion_level}
//               onValueChange={val => handleChange('fashion_level', val)}>
//               <Picker.Item label="Select fashion level" value="" />
//               <Picker.Item label="Expert" value="Expert" />
//               <Picker.Item label="Intermediate" value="Intermediate" />
//               <Picker.Item label="Novice" value="Novice" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>

//       {/* ───────── Gender Picker Modal ───────── */}
//       <Modal visible={showGenderPicker} transparent animationType="slide">
//         <View style={styles.modalRoot}>
//           <TouchableWithoutFeedback onPress={() => setShowGenderPicker(false)}>
//             <View style={styles.backdropHitArea} />
//           </TouchableWithoutFeedback>

//           <View style={styles.sheet}>
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'flex-end',
//                 padding: 12,
//                 borderBottomWidth: 1,
//                 borderColor: theme.colors.surface3,
//               }}>
//               <TouchableOpacity onPress={() => setShowGenderPicker(false)}>
//                 <Text style={{color: theme.colors.primary, fontWeight: '600'}}>
//                   Done
//                 </Text>
//               </TouchableOpacity>
//             </View>

//             <Picker
//               selectedValue={form.gender_presentation}
//               onValueChange={val => handleChange('gender_presentation', val)}>
//               <Picker.Item label="Select gender presentation" value="" />
//               <Picker.Item label="Male" value="Male" />
//               <Picker.Item label="Female" value="Female" />
//               <Picker.Item label="Other" value="Other" />
//             </Picker>
//           </View>
//         </View>
//       </Modal>
//     </ScrollView>
//   );
// }

///////////////

// // screens/OnboardingScreen.tsx
// import React, {useState} from 'react';
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Alert,
// } from 'react-native';
// import * as Animatable from 'react-native-animatable';
// import {useAppTheme} from '../context/ThemeContext';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';

// type Props = {navigate: (screen: string, params?: any) => void};

// export default function OnboardingScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const userId = useUUID();
//   const [saving, setSaving] = useState(false);

//   // 🔥 email removed here
//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   const handleChange = (field: keyof typeof form, value: string) => {
//     setForm(prev => ({...prev, [field]: value}));
//   };

//   const styles = StyleSheet.create({
//     container: {flex: 1},
//     card: {
//       padding: 20,
//       borderRadius: 20,
//       shadowOpacity: 0.1,
//       shadowRadius: 8,
//       backgroundColor: theme.colors.frostedGlass,
//       margin: 6,
//     },
//     title: {
//       fontSize: 36,
//       fontWeight: '600',
//       marginBottom: 22,
//       color: theme.colors.primary,
//       textAlign: 'center',
//     },
//     label: {
//       fontSize: 13,
//       fontWeight: '600',
//       marginBottom: 8,
//       color: theme.colors.primary,
//       textTransform: 'capitalize',
//     },
//     input: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 14,
//       marginBottom: 22,
//       fontSize: 15,
//       backgroundColor: theme.colors.surface3,
//       color: theme.colors.primary,
//     },
//     button: {
//       borderRadius: 14,
//       paddingVertical: 16,
//       alignItems: 'center',
//       marginTop: 20,
//       backgroundColor: theme.colors.button1,
//       opacity: saving ? 0.6 : 1,
//     },
//     buttonText: {fontSize: 16, fontWeight: '600', color: 'white'},
//   });

//   const normalizeGender = (s: string) =>
//     s.trim().toLowerCase().replace(/\s+/g, '_');

//   const buildPayload = () => {
//     const payload: Record<string, any> = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       if (typeof v === 'string') {
//         const trimmed = v.trim();
//         if (trimmed !== '') payload[k] = trimmed;
//       }
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async (token: string | null) => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({} as any));
//         id = (prof && (prof.id || prof.uuid)) || null;
//         console.log('🔎 /auth/profile resolved id:', id, 'raw:', prof);
//       } catch (e) {
//         console.log('⚠️ /auth/profile failed:', e);
//       }
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);
//     console.log('🟢 SAVE BUTTON CLICKED');

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token || null);
//       const payload = buildPayload();
//       console.log('📤 PUT payload ->', payload);

//       if (id && token) {
//         const res = await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT',
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });

//         const text = await res.text();
//         let data: any = null;
//         try {
//           data = text ? JSON.parse(text) : null;
//         } catch {}

//         console.log('📥 PUT /users/:id status:', res.status);
//         console.log('📥 PUT /users/:id body:', data ?? text);

//         if (!res.ok) {
//           Alert.alert(
//             'Profile Save Issue',
//             data?.message || text || 'Update failed.',
//           );
//           console.log('❌ PUT /users/:id failed');
//         } else {
//           console.log('✅ Onboarding saved to DB');
//         }
//       } else {
//         console.log('⚠️ Missing user id or token; skipping server update.');
//       }

//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } catch (err) {
//       console.error('❌ Onboarding save error:', err);
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } finally {
//       setSaving(false);
//     }
//   };

//   return (
//     <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
//       <Animatable.View animation="fadeInUp" duration={600} style={styles.card}>
//         <Text style={styles.title}>Welcome to StylHelpr</Text>

//         {Object.keys(form).map(field => (
//           <View key={field}>
//             <Text style={styles.label}>{field.replace(/_/g, ' ')}</Text>
//             <TextInput
//               style={styles.input}
//               placeholder={`Enter ${field.replace(/_/g, ' ')}`}
//               placeholderTextColor={theme.colors.inputText1}
//               autoCapitalize="none"
//               value={form[field as keyof typeof form]}
//               onChangeText={val =>
//                 handleChange(field as keyof typeof form, val)
//               }
//             />
//           </View>
//         ))}

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={styles.button}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>
//     </ScrollView>
//   );
// }

////////////////

// // screens/OnboardingScreen.tsx
// import React, {useState} from 'react';
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   StyleSheet,
//   ScrollView,
//   ActivityIndicator,
//   Alert,
// } from 'react-native';
// import * as Animatable from 'react-native-animatable';
// import {useAppTheme} from '../context/ThemeContext';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import {getAccessToken} from '../utils/auth';

// type Props = {navigate: (screen: string, params?: any) => void};

// export default function OnboardingScreen({navigate}: Props) {
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const userId = useUUID();
//   const [saving, setSaving] = useState(false);

//   const [form, setForm] = useState({
//     first_name: '',
//     last_name: '',
//     email: '',
//     profession: '',
//     fashion_level: '',
//     gender_presentation: '',
//   });

//   const handleChange = (field: keyof typeof form, value: string) => {
//     setForm(prev => ({...prev, [field]: value}));
//   };

//   const styles = StyleSheet.create({
//     container: {flex: 1},
//     card: {
//       padding: 20,
//       borderRadius: 20,
//       shadowOpacity: 0.1,
//       shadowRadius: 8,
//       backgroundColor: theme.colors.frostedGlass,
//       margin: 6,
//     },
//     title: {
//       fontSize: 36,
//       fontWeight: '600',
//       marginBottom: 22,
//       color: theme.colors.primary,
//       textAlign: 'center',
//     },
//     label: {
//       fontSize: 13,
//       fontWeight: '600',
//       marginBottom: 8,
//       color: theme.colors.primary,
//       textTransform: 'capitalize',
//     },
//     input: {
//       borderRadius: 12,
//       paddingHorizontal: 14,
//       paddingVertical: 14,
//       marginBottom: 22,
//       fontSize: 15,
//       backgroundColor: theme.colors.surface3,
//       color: theme.colors.primary,
//     },
//     button: {
//       borderRadius: 14,
//       paddingVertical: 16,
//       alignItems: 'center',
//       marginTop: 20,
//       backgroundColor: theme.colors.button1,
//       opacity: saving ? 0.6 : 1,
//     },
//     buttonText: {fontSize: 16, fontWeight: '600', color: 'white'},
//   });

//   // Normalize to match your Postgres CHECK constraint
//   const normalizeGender = (s: string) =>
//     s.trim().toLowerCase().replace(/\s+/g, '_'); // ← change '_' to '-' if your DB uses hyphens

//   const buildPayload = () => {
//     const payload: Record<string, any> = {onboarding_complete: true};
//     for (const [k, v] of Object.entries(form)) {
//       if (typeof v === 'string') {
//         const trimmed = v.trim();
//         if (trimmed !== '') payload[k] = trimmed;
//       }
//     }
//     if (payload.gender_presentation) {
//       payload.gender_presentation = normalizeGender(
//         payload.gender_presentation,
//       );
//     }
//     return payload;
//   };

//   const resolveUserId = async (token: string | null) => {
//     let id = userId;
//     if (!id && token) {
//       try {
//         const profRes = await fetch(`${API_BASE_URL}/auth/profile`, {
//           headers: {Authorization: `Bearer ${token}`},
//         });
//         const prof = await profRes.json().catch(() => ({} as any));
//         id = (prof && (prof.id || prof.uuid)) || null; // your /auth/profile returns { uuid: ... }
//         console.log('🔎 /auth/profile resolved id:', id, 'raw:', prof);
//       } catch (e) {
//         console.log('⚠️ /auth/profile failed:', e);
//       }
//     }
//     return id;
//   };

//   const handleSave = async () => {
//     if (saving) return;
//     setSaving(true);
//     console.log('🟢 SAVE BUTTON CLICKED');

//     try {
//       const token = await getAccessToken();
//       const id = await resolveUserId(token || null);

//       const payload = buildPayload();
//       console.log('📤 PUT payload ->', payload);

//       if (id && token) {
//         const res = await fetch(`${API_BASE_URL}/users/${id}`, {
//           method: 'PUT', // matches @Put(':id') on your backend
//           headers: {
//             'Content-Type': 'application/json',
//             Authorization: `Bearer ${token}`,
//           },
//           body: JSON.stringify(payload),
//         });

//         const text = await res.text(); // ensure body is consumed exactly once
//         let data: any = null;
//         try {
//           data = text ? JSON.parse(text) : null;
//         } catch {
//           /* non-JSON; keep raw text */
//         }

//         console.log('📥 PUT /users/:id status:', res.status);
//         console.log('📥 PUT /users/:id body:', data ?? text);

//         if (!res.ok) {
//           // Show quick hint to help you see DB constraint issues fast
//           Alert.alert(
//             'Profile Save Issue',
//             data?.message || text || 'Update failed.',
//           );
//           console.log('❌ PUT /users/:id failed');
//         } else {
//           console.log('✅ Onboarding saved to DB');
//         }
//       } else {
//         console.log('⚠️ Missing user id or token; skipping server update.');
//       }

//       // Local flag so RootNavigator routes to Home immediately
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } catch (err) {
//       console.error('❌ Onboarding save error:', err);
//       // Still unblock locally
//       await AsyncStorage.setItem('onboarding_complete', 'true');
//       navigate('Home');
//     } finally {
//       setSaving(false);
//     }
//   };

//   return (
//     <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
//       <Animatable.View animation="fadeInUp" duration={600} style={styles.card}>
//         <Text style={styles.title}>Welcome to StylHelpr</Text>

//         {Object.keys(form).map(field => (
//           <View key={field}>
//             <Text style={styles.label}>{field.replace(/_/g, ' ')}</Text>
//             <TextInput
//               style={styles.input}
//               placeholder={`Enter ${field.replace(/_/g, ' ')}`}
//               placeholderTextColor={theme.colors.inputText1}
//               autoCapitalize="none"
//               value={form[field as keyof typeof form]}
//               onChangeText={val =>
//                 handleChange(field as keyof typeof form, val)
//               }
//             />
//           </View>
//         ))}

//         <AppleTouchFeedback hapticStyle="impactMedium">
//           <TouchableOpacity
//             style={styles.button}
//             activeOpacity={0.85}
//             onPress={handleSave}
//             disabled={saving}>
//             {saving ? (
//               <ActivityIndicator />
//             ) : (
//               <Text style={styles.buttonText}>Save Profile</Text>
//             )}
//           </TouchableOpacity>
//         </AppleTouchFeedback>
//       </Animatable.View>
//     </ScrollView>
//   );
// }
