// src/styles/globalStyles.ts
// ---------------------------------------------------------------------------
// 🔹 Purpose:
// Defines all global React Native styles shared across the app.
// Provides consistent design primitives (spacing, radii, typography, etc.)
// and responsive behavior across phones, Pro Max devices, and tablets.
//
// 🔹 Core Features:
// - Uses Dimensions for static device breakpoints (phone / tablet).
// - Imports design tokens (borderRadius, borderWidth, etc.) from tokens.ts.
// - Pulls the current color palette from ThemeContext (light/dark).
// - Centralizes card, button, text, image, and layout styles.
//
// 🔹 When to use:
// Call `createGlobalStyles(theme)` inside a screen or component to
// access unified styles: `const global = createGlobalStyles(theme)`
// ---------------------------------------------------------------------------

import {StyleSheet, Dimensions} from 'react-native';
import {tokens} from './tokens/tokens';
import type {Theme} from '../context/ThemeContext';
import {fontScale, scale} from '../utils/scale';
// import { useSafeAreaInsets } from 'react-native-safe-area-context';
// const insets = useSafeAreaInsets();
// screen: { paddingTop: insets.top, paddingBottom: insets.bottom + tokens.spacing.lg }

// ---------------------------------------------------------------------------
// 🧭 Device breakpoints
// Determines device class once at load time. Used for static style tiers.
// ---------------------------------------------------------------------------
// const {width: screenWidth} = Dimensions.get('window');
// const isLargePhone = screenWidth >= 430; // iPhone Pro Max & similar large phones
// const isTablet = screenWidth >= 768; // Tablets / iPads / large foldables

const {width: screenWidth} = Dimensions.get('window');
export const isSmallPhone = screenWidth <= 380; // SE, 13 mini
export const isRegularPhone = screenWidth > 380 && screenWidth < 430; // 11–17 normal
export const isLargePhone = screenWidth >= 430 && screenWidth < 768; // Plus / Pro Max
export const isTablet = screenWidth >= 768; // iPads

// ---------------------------------------------------------------------------
// 📐 Responsive constants
// Defines adaptive spacing, padding, and element dimensions for each device tier.
// These are static (computed once) for performance and predictability.
// ---------------------------------------------------------------------------
const responsivePadding = isTablet ? 38 : 20;
const sectionMarginBottom = isTablet ? 32 : 24;

const image1Width = isTablet ? 270 : 165;
const image1Height = isTablet ? 150 : 95;
const image2Width = isTablet ? 270 : 165;
const image2Height = isTablet ? 150 : 95;
const image4Size = isTablet ? 160 : 110;
const outfitCardSize = isTablet ? 164 : 110;

// ---------------------------------------------------------------------------
// 🔤 Breakpoint-based typography tiers
// Fonts never scale automatically with screen width — only through fixed tiers.
// This keeps typography visually consistent (Apple-style design philosophy).
// ---------------------------------------------------------------------------
// const font = {
//   xs: isTablet ? 14 : isLargePhone ? 13 : 12, // tiny captions
//   sm: isTablet ? 15 : isLargePhone ? 14 : 13, // labels, metadata
//   md: isTablet ? 17 : isLargePhone ? 16 : 15, // body text
//   lg: isTablet ? 19 : isLargePhone ? 18 : 17, // section titles
//   xl: isTablet ? 22 : isLargePhone ? 20 : 18, // large titles
//   heading: isTablet ? 36 : isLargePhone ? 34 : 32, // hero headers
// };

// const font = {
//   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
//   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
//   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
//   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
//   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
//   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// };
const font = {
  xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
  sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
  md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
  lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
  xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
  xxl: isTablet ? tokens.fontSize.xxl + 2 : tokens.fontSize.xxl,
  heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
};

// ---------------------------------------------------------------------------
// 🎨 Global StyleSheet factory
// Generates a complete theme-aware, responsive style map for your UI.
// Each block is organized by functional category for clarity.
// ---------------------------------------------------------------------------
export const createGlobalStyles = (theme: Theme) =>
  StyleSheet.create({
    // ============================================================
    // 🌎 Core Layout Containers
    // ============================================================
    screen: {
      flex: 1,
      // backgroundColor: theme.colors.background, // entire screen background
    },
    container: {
      // paddingTop: isTablet ? 10 : isLargePhone ? 8 : 5,
      // paddingBottom: isTablet ? 80 : isLargePhone ? 70 : 60,
      paddingTop: isTablet ? 10 : isLargePhone ? 8 : isRegularPhone ? 5 : 5,
      paddingBottom: isTablet
        ? 80
        : isLargePhone
          ? 70
          : isRegularPhone
            ? 60
            : 60,
      width: '100%',
      alignSelf: 'center',
      flexGrow: 1,
    },
    centeredSection: {
      width: '100%',
      maxWidth: isTablet ? 820 : 720,
      alignSelf: 'center', // keeps sections centered on large devices
    },

    // ============================================================
    // 🧩 Layout Sections
    // ============================================================
    section: {
      // marginBottom: isTablet ? 32 : isLargePhone ? 20 : 20,
      // paddingHorizontal: isTablet ? 38 : isLargePhone ? 16 : 16,
      marginBottom: isTablet
        ? 32
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 20
            : 20,
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 16
          : isRegularPhone
            ? 16
            : 16,
    },
    section2: {
      marginBottom: isTablet
        ? 32
        : isLargePhone
          ? 28
          : isRegularPhone
            ? 22
            : 22,
    },
    section3: {
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 26
          : isRegularPhone
            ? 26
            : 26,
      marginTop: isTablet ? 26 : isLargePhone ? 22 : isRegularPhone ? 18 : 18,
      marginBottom: isTablet
        ? 26
        : isLargePhone
          ? 22
          : isRegularPhone
            ? 18
            : 18,
    },
    section4: {
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 26
          : isRegularPhone
            ? 26
            : 26,
    },
    section5: {
      width: '100%',
      maxWidth: isTablet
        ? 820
        : isLargePhone
          ? 720
          : isRegularPhone
            ? 720
            : 720,
      alignSelf: 'center',
      borderRadius: tokens.borderRadius.md,
    },
    section6: {
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 16
          : isRegularPhone
            ? 16
            : 16,
    },
      section7: {
      // marginBottom: isTablet ? 32 : isLargePhone ? 20 : 20,
      // paddingHorizontal: isTablet ? 38 : isLargePhone ? 16 : 16,
      marginBottom: isTablet
        ? 32
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 20
            : 20,
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 8
          : isRegularPhone
            ? 16
            : 16,
    },
    sectionScroll: {
      marginBottom: isTablet
        ? 36
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 20
            : 20,
      paddingLeft: isTablet
        ? 38
        : isLargePhone
          ? 18
          : isRegularPhone
            ? 18
            : isRegularPhone
              ? 18
              : 18,
    },
    sectionScroll2: {
      // marginBottom: isTablet ? 22 : isLargePhone ? 8 : 8,
      paddingLeft: isTablet ? 38 : isLargePhone ? 20 : isRegularPhone ? 18 : 18,
    },

    // ============================================================
    // 🪟 Modal Containers
    // ============================================================
    modalSection: {
      width: '100%',
      backgroundColor: theme.colors.surface,
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 18
          : isRegularPhone
            ? 18
            : 18,
      // maxWidth: isTablet ? 820 : 720,
      alignSelf: 'center',
      borderRadius: tokens.borderRadius.md,
    },
    modalSection2: {
      width: '100%',
      // maxWidth: isTablet ? 820 : 720,
      maxWidth: isTablet
        ? 820
        : isLargePhone
          ? 720
          : isRegularPhone
            ? 720
            : 720,
      alignSelf: 'center',
      borderRadius: tokens.borderRadius.md,
    },
    modalSection3: {
      width: '100%',
      paddingHorizontal: isTablet
        ? 38
        : isLargePhone
          ? 18
          : isRegularPhone
            ? 18
            : 18,
      maxWidth: isTablet
        ? 820
        : isLargePhone
          ? 720
          : isRegularPhone
            ? 720
            : 720,
      alignSelf: 'center',
      borderRadius: tokens.borderRadius.md,
    },

    // ============================================================
    // 💳 Card Styles (shadows, borders, background variants)
    // ============================================================
    cardStyles1: {
      padding: isTablet ? 20 : isLargePhone ? 18 : isRegularPhone ? 14 : 14,
      // borderWidth: tokens.borderWidth.hairline,
      // borderColor: theme.colors.surfaceBorder,
      borderRadius: tokens.borderRadius.xxxl,
      // borderRadius: tokens.borderRadius.sm,
      backgroundColor: theme.colors.surface,

      // shadowColor: '#000',
      // shadowOffset: {width: 0, height: 4},
      // shadowOpacity: 0.15,
      // shadowRadius: 8,
      // elevation: 5,

      // shadowColor: 'rgb(0, 0, 0)',
      // shadowOffset: {width: 6, height: 9},
      // shadowOpacity: 0.9,
      // shadowRadius: 7,
      // elevation: 6,

      // shadowColor: '#000',
      // shadowOffset: {width: 8, height: 10},
      // shadowOpacity: 0.5,
      // shadowRadius: 5,
      // elevation: 6,

      // shadowColor: '#000',
      // shadowOffset: {width: 8, height: 9},
      // shadowOpacity: 0.5,
      // shadowRadius: 5,
      // elevation: 6,

      // shadowColor: '#000',
      // shadowOffset: {width: 4, height: 4},
      // shadowOpacity: 0.3,
      // shadowRadius: 7,
      // elevation: 5,
    },
    cardStyles2: {
      padding: isTablet ? 18 : isLargePhone ? 16 : isRegularPhone ? 12 : 12,
      shadowOffset: {width: 0, height: 6},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 5,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
      borderRadius: tokens.borderRadius.md,
    },
    cardStyles3: {
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.surfaceBorder,
    },
    cardStyles4: {
      shadowOffset: {width: 0, height: 6},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 5,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      borderRadius: tokens.borderRadius.md,
    },
    cardStyles5: {
      paddingVertical: isTablet ? 20 : isLargePhone ? 18 : isRegularPhone ? 14 : 14,
      paddingHorizontal: isTablet ? 20 : isLargePhone ? 8 : isRegularPhone ? 8 : 8,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
      borderRadius: tokens.borderRadius.xxxl,
      backgroundColor: theme.colors.surface,

      // shadowColor: '#000',
      // shadowOffset: {width: 4, height: 4},
      // shadowOpacity: 0.3,
      // shadowRadius: 7,
      // elevation: 5,
    },

    cardStyles6: {
      // paddingVertical: isTablet ? 8 : isLargePhone ? 8 : isRegularPhone ? 8 : 8,
      // paddingHorizontal: isTablet ? 20 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
      borderRadius: tokens.borderRadius.xxxl,
          // borderRadius: tokens.borderRadius.xl,
       backgroundColor: theme.colors.surface,

      // shadowColor: '#000',
      // shadowOffset: {width: 4, height: 4},
      // shadowOpacity: 0.3,
      // shadowRadius: 7,
      // elevation: 5,
    },

    newsCard1: {
      paddingVertical: isTablet
        ? 14
        : isLargePhone
          ? 14
          : isRegularPhone
            ? 14
            : 14,
      paddingHorizontal: isTablet
        ? 16
        : isLargePhone
          ? 16
          : isRegularPhone
            ? 16
            : 16,
      // backgroundColor: theme.colors.surface,
      marginBottom: isTablet ? 8 : isLargePhone ? 8 : isRegularPhone ? 8 : 8,
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.xl,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
      marginHorizontal: isTablet
        ? 16
        : isLargePhone
          ? 16
          : isRegularPhone
            ? 16
            : 16,
      // elevation: 10,
      transform: [{scale: 1}],
    },

    // ============================================================
    // 🏷️ Typography Styles
    // ============================================================
    header: {
      paddingLeft: isTablet ? 24 : isLargePhone ? 18 : isRegularPhone ? 18 : 18,
      fontSize: font.heading,
      fontWeight: tokens.fontWeight.bold,
      color: theme.colors.foreground,
    },
    backContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      width: isTablet ? 120 : isLargePhone ? 100 : isRegularPhone ? 100 : 100,
    },
    backText: {
      fontSize: font.md,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.button3,
    },
    // sectionTitle: {
    //   // fontSize: font.lg,
    //   fontSize: font.xl,
    //   // fontWeight: tokens.fontWeight.bold,
    //   // fontWeight: tokens.fontWeight.normal,
    //   fontWeight: tokens.fontWeight.medium,
    //   // fontWeight: tokens.fontWeight.light,
    //   // fontWeight: tokens.fontWeight.extraLight,
    //   color: theme.colors.foreground,
    //   marginBottom: isTablet
    //     ? 10
    //     : isLargePhone
    //     ? 10
    //     : isRegularPhone
    //     ? 10
    //     : 10,
    //   // textTransform: 'uppercase',
    // },
    sectionTitle: {
      fontSize: font.lg,
      // fontSize: font.xl,
      fontWeight: tokens.fontWeight.bold,
      // fontWeight: tokens.fontWeight.normal,
      // fontWeight: tokens.fontWeight.medium,
      // fontWeight: tokens.fontWeight.light,
      // fontWeight: tokens.fontWeight.extraLight,
      color: theme.colors.foreground,
      marginBottom: isTablet
        ? 10
        : isLargePhone
          ? 8
          : isRegularPhone
            ? 8
            : 8,
      textTransform: 'uppercase',
    },
    sectionTitle2: {
      fontSize: font.md,
      fontWeight: tokens.fontWeight.medium,
      lineHeight: isTablet ? 26 : isLargePhone ? 24 : isRegularPhone ? 24 : 24,
      color: theme.colors.foreground,
      marginBottom: 2,
    },
    sectionTitle3: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      lineHeight: isTablet ? 26 : isLargePhone ? 24 : isRegularPhone ? 24 : 24,
      color: theme.colors.foreground,
      marginBottom: 2,
    },
    sectionTitle4: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.normal,
      lineHeight: isTablet ? 26 : isLargePhone ? 24 : isRegularPhone ? 24 : 24,
      color: theme.colors.foreground,
    },
    sectionTitle5: {
      fontSize: font.lg,
      fontWeight: tokens.fontWeight.extraBold,
      lineHeight: isTablet ? 28 : isLargePhone ? 24 : isRegularPhone ? 24 : 24,
      color: theme.colors.foreground,
      marginBottom: 2,
      textTransform: 'uppercase',
    },

    // ============================================================
    // 🧱 Content Containers + Titles
    // ============================================================
    styleContainer1: {
      flexDirection: 'column',
      justifyContent: 'center',
      marginTop: isTablet ? 14 : isLargePhone ? 12 : isRegularPhone ? 10 : 10,
      marginBottom: isTablet
        ? 26
        : isLargePhone
          ? 22
          : isRegularPhone
            ? 18
            : 18,
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xxl,
      paddingTop: isTablet ? 24 : isLargePhone ? 20 : isRegularPhone ? 16 : 16,
      paddingHorizontal: isTablet
        ? 24
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 16
            : 16,
      paddingBottom: isTablet ? 12 : isLargePhone ? 10 : isRegularPhone ? 8 : 8,
    },
    title: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.foreground,
      marginBottom: isTablet
        ? 14
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 10
            : 10,
    },
    title2: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.foreground,
      marginBottom: isTablet
        ? 14
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 10
            : 10,
    },
    title3: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
      marginBottom: isTablet ? 8 : isLargePhone ? 6 : isRegularPhone ? 6 : 6,
      marginTop: isTablet ? 6 : isLargePhone ? 4 : isRegularPhone ? 4 : 4,
    },
    titleBold: {
      fontSize: font.lg,
      fontWeight: tokens.fontWeight.extraBold,
      marginBottom: -4,
      color: theme.colors.foreground,
    },

    // ============================================================
    // 🏷️ Labels + Subtext
    // ============================================================
    label: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    label2: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.semiBold,
      width: '25%',
      color: theme.colors.foreground2,
    },
    subLabel: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.semiBold,
      // fontWeight: tokens.fontWeight.medium,
      marginTop: 2,
      color: theme.colors.foreground2,
    },
    cardLabel: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.foreground,
    },
    cardSubLabel: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.semiBold,
      marginTop: 2,
      color: theme.colors.foreground2,
    },

    // ============================================================
    // 🍔 Menus + List Sections
    // ============================================================
    menuContainer1: {
      flexDirection: 'column',
      justifyContent: 'center',
      marginTop: isTablet ? 14 : isLargePhone ? 10 : isRegularPhone ? 8 : 8,
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xxl,
      paddingHorizontal: isTablet
        ? 22
        : isLargePhone
          ? 18
          : isRegularPhone
            ? 14
            : 14,
    },
    menuSection1: {
      flexDirection: 'column',
      justifyContent: 'center',
      paddingHorizontal: isTablet
        ? 12
        : isLargePhone
          ? 10
          : isRegularPhone
            ? 8
            : 8,
      paddingVertical: isTablet
        ? 24
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 16
            : 16,
    },
    menuSection2: {
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xxl,
      paddingHorizontal: isTablet
        ? 32
        : isLargePhone
          ? 28
          : isRegularPhone
            ? 24
            : 24,
      paddingVertical: isTablet
        ? 22
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 18
            : 18,
    },
    menuSection3: {
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.md,
      paddingHorizontal: isTablet
        ? 32
        : isLargePhone
          ? 18
          : isRegularPhone
            ? 24
            : 24,
    },
    menuLabel: {
      fontSize: font.lg,
      fontWeight: tokens.fontWeight.normal,
      color: theme.colors.foreground,
    },

    // ============================================================
    // 💊 Pill Elements
    // ============================================================
    labelContainer: {
      paddingVertical: isTablet
        ? 10
        : isLargePhone
          ? 6
          : isRegularPhone
            ? 6
            : 6,
      // paddingHorizontal: isTablet
      //   ? 16
      //   : isLargePhone
      //     ? 8
      //     : isRegularPhone
      //       ? 8
      //       : 8,
    },
    labelContainer2: {
      paddingHorizontal: isTablet
        ? 16
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 12
            : 12,
    },
    labelContainer3: {
      paddingVertical: isTablet ? 8 : isLargePhone ? 6 : isRegularPhone ? 6 : 6,
      paddingHorizontal: isTablet
        ? 16
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 12
            : 12,
    },
    labelContainer4: {
      // backgroundColor: 'red',
    },
    pillContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-start',
      width: '100%',
    },
    pill: {
      backgroundColor: theme.colors.foreground,
      paddingHorizontal: isTablet
        ? 22
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 18
            : 18,
      paddingVertical: isTablet
        ? 10
        : isLargePhone
          ? 9
          : isRegularPhone
            ? 8
            : 8,
      borderRadius: 18,
      marginRight: isTablet ? 10 : isLargePhone ? 8 : isRegularPhone ? 6 : 6,
    },
    pill2: {
      paddingHorizontal: isTablet
        ? 22
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 18
            : 18,
      paddingVertical: isTablet
        ? 10
        : isLargePhone
          ? 9
          : isRegularPhone
            ? 8
            : 8,
      backgroundColor: theme.colors.pillDark2,
      borderRadius: 18,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
      marginRight: isTablet ? 10 : isLargePhone ? 8 : isRegularPhone ? 6 : 6,
    },
    pill3: {
      backgroundColor: theme.colors.foreground,
      paddingHorizontal: isTablet
        ? 22
        : isLargePhone
          ? 20
          : isRegularPhone
            ? 18
            : 18,
      paddingVertical: isTablet
        ? 10
        : isLargePhone
          ? 9
          : isRegularPhone
            ? 8
            : 8,
      borderRadius: 18,
      marginRight: isTablet ? 10 : isLargePhone ? 8 : isRegularPhone ? 6 : 6,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.surfaceBorder,
    },
    pillText: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.background,
    },
    pillText2: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.button1,
    },
    pillFixedWidth: {
      backgroundColor: theme.colors.surface,
      paddingVertical: 9,
      borderRadius: 18,
      alignSelf: 'flex-start',
      width: '32%',
      shadowOffset: {width: 0, height: 6},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 5,
    },
    pillTextFixedWidth: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.foreground,
      textAlign: 'center',
    },
    pillFixedWidth2: {
      backgroundColor: theme.colors.surface,
      paddingVertical: 9,
      borderRadius: 18,
      shadowOffset: {width: 0, height: 6},
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 5,
      alignSelf: 'flex-start',
      width: '23%',
    },
    pillTextFixedWidth2: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.medium,
      color: theme.colors.foreground,
      textAlign: 'center',
    },

    // ============================================================
    // 🔘 Buttons
    // ============================================================
    buttonHome: {
      width: '90%',
      maxWidth: isTablet
        ? 300
        : isLargePhone
          ? 270
          : isRegularPhone
            ? 270
            : 270,
      paddingVertical: isTablet
        ? 18
        : isLargePhone
          ? 16
          : isRegularPhone
            ? 14
            : 14,
      borderRadius: tokens.borderRadius.md,
      marginBottom: isTablet
        ? 26
        : isLargePhone
          ? 22
          : isRegularPhone
            ? 18
            : 18,
      alignItems: 'center',
      backgroundColor: 'black',
    },
    buttonHomeText: {
      fontSize: font.lg,
      fontWeight: tokens.fontWeight.semiBold,
      color: '#fff',
      textShadowColor: 'rgba(0,0,0,0.7)',
      textShadowOffset: {width: 0, height: 1},
      textShadowRadius: 3,
    },
    buttonPrimary: {
      backgroundColor: theme.colors.button1,
      // borderRadius: tokens.borderRadius['2xl'],
      borderRadius: tokens.borderRadius.sm,
      // borderRadius: tokens.borderRadius.xxl,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 1},
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
      borderColor: theme.colors.surfaceBorder,
      paddingVertical: isTablet
        ? 16
        : isLargePhone
          ? 14
          : isRegularPhone
            ? 12
            : 12,
      borderWidth: 1,
    },
    buttonPrimaryText: {
      fontSize: font.md,
      fontWeight: tokens.fontWeight.semiBold,
      color: theme.colors.buttonText1,
    },
    buttonSecondary: {
      backgroundColor: theme.colors.button2,
      borderRadius: tokens.borderRadius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 1},
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
      borderColor: theme.colors.surfaceBorder,
      paddingVertical: isTablet
        ? 16
        : isLargePhone
          ? 14
          : isRegularPhone
            ? 12
            : 12,
      borderWidth: 1,
    },
    buttonSecondaryText: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.semiBold,
      color: '#fff',
    },
    buttonTertiary: {
      width: isTablet ? 110 : isLargePhone ? 90 : isRegularPhone ? 90 : 90,
      maxWidth: 186,
      backgroundColor: theme.colors.surface2,
      borderRadius: tokens.borderRadius.sm,
      paddingVertical: isTablet
        ? 14
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 10
            : 10,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 1},
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
    },
    buttonTertiaryText: {
      fontSize: font.sm,
      fontWeight: tokens.fontWeight.semiBold,
      color: '#fff',
    },
    buttonPrimary4: {
      // backgroundColor: theme.colors.button1,
      // borderRadius: tokens.borderRadius['2xl'],
      borderRadius: tokens.borderRadius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      // shadowColor: '#000',
      // shadowOffset: {width: 0, height: 1},
      // shadowOpacity: 0.1,
      // shadowRadius: 4,
      // elevation: 2,
      // borderColor: theme.colors.button1,
      borderColor: theme.colors.muted,
      paddingVertical: isTablet ? 10 : isLargePhone ? 9 : 9,
      borderWidth: tokens.borderWidth.hairline,
    },
    buttonPrimaryText4: {
      fontSize: font.xs,
      fontWeight: tokens.fontWeight.bold,
      color: theme.colors.buttonText1,
    },

    // ============================================================
    // 🖼️ Image + Media
    // ============================================================
    image1: {
      width: isTablet ? 108 : isLargePhone ? 92 : isRegularPhone ? 92 : 92,
      height: isTablet ? 108 : isLargePhone ? 92 : isRegularPhone ? 92 : 92,
      borderRadius: tokens.borderRadius.sm,
      backgroundColor: '#eee',
    },
    image2: {
      width: isTablet ? 108 : isLargePhone ? 92 : isRegularPhone ? 92 : 92,
      height: isTablet ? 108 : isLargePhone ? 92 : isRegularPhone ? 92 : 92,
      borderTopLeftRadius: isTablet
        ? 16
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 12
            : 12,
      borderTopRightRadius: isTablet
        ? 16
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 12
            : 12,
      backgroundColor: theme.colors.surface,
    },
    image3: {
      width: isTablet ? 200 : isLargePhone ? 165 : isRegularPhone ? 165 : 165,
      height: isTablet ? 120 : isLargePhone ? 95 : isRegularPhone ? 95 : 95,
      borderRadius: tokens.borderRadius.lg,
      backgroundColor: theme.colors.surface,
    },
    image4: {
      // width: image4Size,
      // height: image4Size,
      width: 160,
      height: 130,
      backgroundColor: '#eee',
      borderRadius: tokens.borderRadius.lg,
    },
    image5: {
      width: '100%',
      // height: isTablet ? 160 : isLargePhone ? 115 : 125,
      height: isTablet
        ? 160
        : isLargePhone
          ? 110
          : isRegularPhone
            ? 115
            : isRegularPhone
              ? 105
              : 105,
      backgroundColor: theme.colors.surface,
      // borderRadius: tokens.borderRadius.sm,
      // borderBottomWidth: tokens.borderWidth.md,
      // borderBottomColor: theme.colors.surfaceBorder,
    },
    image6: {
      width: '100%',
      backgroundColor: theme.colors.foreground,
    },
    image7: {
      // width: image4Size,
      // height: image4Size,
      // backgroundColor: theme.colors.surface3,
      width: '100%',
      // height: isTablet ? 160 : isLargePhone ? 140 : 125,
      height: isTablet ? 160 : isLargePhone ? 160 : isRegularPhone ? 115 : 105,
    },
    image8: {
      // width: image4Size,
      // height: image4Size,
      // backgroundColor: theme.colors.surface,
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.switch1,
      // borderWidth: tokens.borderWidth.hairline,
      // borderColor: theme.colors.surfaceBorder,
      width: isTablet ? 160 : isLargePhone ? 122 : isRegularPhone ? 122 : 105,
      // height: isTablet ? 160 : isLargePhone ? 175 : 145,
      // height: isTablet ? 160 : isLargePhone ? 140 : 125,
      // height: isTablet ? 160 : isLargePhone ? 155 : 145,
      // height: isTablet ? 160 : isLargePhone ? 120 : isRegularPhone ? 115 : 105,
      height: isTablet ? 160 : isLargePhone ? 122 : isRegularPhone ? 115 : 105,
    },
    image9: {
      width: isTablet
        ? 189
        : isLargePhone
          ? 189
          : isRegularPhone
            ? 166.5
            : 166.5,
      borderRadius: tokens.borderRadius.lg,
      backgroundColor: theme.colors.surface,
      overflow: 'hidden',
      // borderColor: theme.colors.surfaceBorder,
      // borderWidth: tokens.borderWidth.md,
    },
    image10: {
      width: '100%',
      height: isTablet ? 160 : isLargePhone ? 165 : isRegularPhone ? 165 : 165,
      backgroundColor: 'white',
      // borderRadius: tokens.borderRadius.sm,
      borderBottomWidth: tokens.borderWidth.md,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    image11: {
      width: '100%',
      height: isTablet ? 160 : isLargePhone ? 120 : isRegularPhone ? 120 : 120,

    },
    bgContainer1: {
      height: isTablet ? 260 : isLargePhone ? 305 : isRegularPhone ? 260 : 260,
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.switch1,
      overflow: 'hidden',
      // shadowColor: '#000',
      // shadowOpacity: 0.35,
      // shadowRadius: 20,
      // shadowOffset: {width: 0, height: 10},
      // elevation: 12,
      backgroundColor: theme.colors.surface,
      transform: [{scale: 1}],
      marginBottom: 2,
    },

    // ============================================================
    // 🧥 Outfit Cards + Lists
    // ============================================================
    outfitCard: {
      // width: outfitCardSize,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : 10,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      marginRight: isTablet ? 16 : isLargePhone ? 8 : isRegularPhone ? 8 : 8,
      // alignItems: 'flex-start',
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.sm,
    },

    outfitCard2: {
      // width: isTablet ? 160 : isLargePhone ? 180 : 160,
      width: isTablet ? 160 : isLargePhone ? 160 : isRegularPhone ? 160 : 160,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      marginRight: isTablet ? 16 : isLargePhone ? 8 : isRegularPhone ? 8 : 8,
      alignItems: 'flex-start',
      // backgroundColor: theme.colors.surface,
      overflow: 'hidden',
      // borderRadius: tokens.borderRadius.lg,
      // borderRadius: tokens.borderRadius.sm,
       borderRadius: tokens.borderRadius.switch1,
      // borderWidth: tokens.borderWidth.hairline,
      // borderColor: theme.colors.surfaceBorder,
    },

    outfitCard3: {
      // width: 220,
      // width: 275,
      // width: isTablet ? 275 : isLargePhone ? 275 : 230,
      width: isTablet ? 275 : isLargePhone ? 235 : isRegularPhone ? 230 : 230,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      marginRight: isTablet ? 16 : isLargePhone ? 10 : isRegularPhone ? 10 : 10,
      alignItems: 'flex-start',
      backgroundColor: theme.colors.surface,
      overflow: 'hidden',
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.sm,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
    },

    outfitCard4: {
      width: isTablet ? 160 : isLargePhone ? 195 : isRegularPhone ? 184 : 165,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      alignItems: 'flex-start',
      overflow: 'hidden',
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.switch1,
      // borderWidth: tokens.borderWidth.hairline,
      // borderColor: theme.colors.surfaceBorder,
    },

       outfitCard5: {
      width: isTablet ? 160 : isLargePhone ? 195 : isRegularPhone ? 184 : 165,
      // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
      alignItems: 'flex-start',
      overflow: 'hidden',
      // borderRadius: tokens.borderRadius.lg,
      borderRadius: tokens.borderRadius.switch1,
      // borderWidth: tokens.borderWidth.hairline,
      // borderColor: theme.colors.surfaceBorder,
    },


    // ============================================================
    // 🎙️ Prompt Input (Voice/Chat Bar)
    // ============================================================
    promptRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#1a1a1a',
      borderRadius: tokens.borderRadius.md,
      paddingHorizontal: isTablet
        ? 16
        : isLargePhone
          ? 12
          : isRegularPhone
            ? 12
            : 12,
      width: '100%',
    },
    promptInput: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: font.md,
    },

    // ============================================================
    // ✍️ Utility + Miscellaneous
    // ============================================================
    hrLine: {
      borderBottomWidth: 1,
      borderColor: 'rgba(74, 74, 74, 0.37)',
    },
    boxShadowLight: {
      shadowColor: 'rgb(0, 0, 0)',
      shadowOffset: {width: 10, height: 8},
      shadowOpacity: 0.5,
      shadowRadius: 7,
      elevation: 6,
    },
    boxShadowDark: {
      shadowColor: 'rgb(73, 73, 73)',
      shadowOffset: {width: 10, height: 8},
      shadowOpacity: 0.5,
      shadowRadius: 7,
      elevation: 6,
    },
    missingDataMessage1: {
      color: theme.colors.muted,
      textAlign: 'left',
      marginTop: 0,
      lineHeight: 20,
      maxWidth: isTablet
        ? 500
        : isLargePhone
          ? 400
          : isRegularPhone
            ? 400
            : 400,
    },
  });

/////////////////////////

// // src/styles/globalStyles.ts
// // ---------------------------------------------------------------------------
// // 🔹 Purpose:
// // Defines all global React Native styles shared across the app.
// // Provides consistent design primitives (spacing, radii, typography, etc.)
// // and responsive behavior across phones, Pro Max devices, and tablets.
// //
// // 🔹 Core Features:
// // - Uses Dimensions for static device breakpoints (phone / tablet).
// // - Imports design tokens (borderRadius, borderWidth, etc.) from tokens.ts.
// // - Pulls the current color palette from ThemeContext (light/dark).
// // - Centralizes card, button, text, image, and layout styles.
// //
// // 🔹 When to use:
// // Call `createGlobalStyles(theme)` inside a screen or component to
// // access unified styles: `const global = createGlobalStyles(theme)`
// // ---------------------------------------------------------------------------

// import {StyleSheet, Dimensions} from 'react-native';
// import {tokens} from './tokens/tokens';
// import type {Theme} from '../context/ThemeContext';
// import {fontScale, scale} from '../utils/scale';
// // import { useSafeAreaInsets } from 'react-native-safe-area-context';
// // const insets = useSafeAreaInsets();
// // screen: { paddingTop: insets.top, paddingBottom: insets.bottom + tokens.spacing.lg }

// // ---------------------------------------------------------------------------
// // 🧭 Device breakpoints
// // Determines device class once at load time. Used for static style tiers.
// // ---------------------------------------------------------------------------
// // const {width: screenWidth} = Dimensions.get('window');
// // const isLargePhone = screenWidth >= 430; // iPhone Pro Max & similar large phones
// // const isTablet = screenWidth >= 768; // Tablets / iPads / large foldables

// const {width: screenWidth} = Dimensions.get('window');
// export const isSmallPhone = screenWidth <= 380; // SE, 13 mini
// export const isRegularPhone = screenWidth > 380 && screenWidth < 430; // 11–17 normal
// export const isLargePhone = screenWidth >= 430 && screenWidth < 768; // Plus / Pro Max
// export const isTablet = screenWidth >= 768; // iPads

// // ---------------------------------------------------------------------------
// // 📐 Responsive constants
// // Defines adaptive spacing, padding, and element dimensions for each device tier.
// // These are static (computed once) for performance and predictability.
// // ---------------------------------------------------------------------------
// const responsivePadding = isTablet ? 38 : 20;
// const sectionMarginBottom = isTablet ? 32 : 24;

// const image1Width = isTablet ? 270 : 165;
// const image1Height = isTablet ? 150 : 95;
// const image2Width = isTablet ? 270 : 165;
// const image2Height = isTablet ? 150 : 95;
// const image4Size = isTablet ? 160 : 110;
// const outfitCardSize = isTablet ? 164 : 110;

// // ---------------------------------------------------------------------------
// // 🔤 Breakpoint-based typography tiers
// // Fonts never scale automatically with screen width — only through fixed tiers.
// // This keeps typography visually consistent (Apple-style design philosophy).
// // ---------------------------------------------------------------------------
// // const font = {
// //   xs: isTablet ? 14 : isLargePhone ? 13 : 12, // tiny captions
// //   sm: isTablet ? 15 : isLargePhone ? 14 : 13, // labels, metadata
// //   md: isTablet ? 17 : isLargePhone ? 16 : 15, // body text
// //   lg: isTablet ? 19 : isLargePhone ? 18 : 17, // section titles
// //   xl: isTablet ? 22 : isLargePhone ? 20 : 18, // large titles
// //   heading: isTablet ? 36 : isLargePhone ? 34 : 32, // hero headers
// // };

// // const font = {
// //   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
// //   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
// //   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
// //   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
// //   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
// //   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// // };
// const font = {
//   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
//   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
//   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
//   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
//   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
//   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// };

// // ---------------------------------------------------------------------------
// // 🎨 Global StyleSheet factory
// // Generates a complete theme-aware, responsive style map for your UI.
// // Each block is organized by functional category for clarity.
// // ---------------------------------------------------------------------------
// export const createGlobalStyles = (theme: Theme) =>
//   StyleSheet.create({
//     // ============================================================
//     // 🌎 Core Layout Containers
//     // ============================================================
//     screen: {
//       flex: 1,
//       // backgroundColor: theme.colors.background, // entire screen background
//     },
//     container: {
//       paddingTop: isTablet ? 10 : isLargePhone ? 8 : 5,
//       paddingBottom: isTablet ? 80 : isLargePhone ? 70 : 60,
//       width: '100%',
//       alignSelf: 'center',
//       flexGrow: 1,
//     },
//     centeredSection: {
//       width: '100%',
//       maxWidth: isTablet ? 820 : 720,
//       alignSelf: 'center', // keeps sections centered on large devices
//     },

//     // ============================================================
//     // 🧩 Layout Sections
//     // ============================================================
//     section: {
//       marginBottom: isTablet ? 32 : isLargePhone ? 20 : 20,
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 16 : 16,
//     },
//     section2: {
//       marginBottom: isTablet ? 32 : isLargePhone ? 28 : 22,
//     },
//     section3: {
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 26 : 26,
//       marginTop: isTablet ? 26 : isLargePhone ? 22 : 18,
//       marginBottom: isTablet ? 26 : isLargePhone ? 22 : 18,
//     },
//     section4: {
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 26 : 26,
//     },
//     section5: {
//       width: '100%',
//       maxWidth: isTablet ? 820 : 720,
//       alignSelf: 'center',
//       borderRadius: tokens.borderRadius.md,
//     },
//     section6: {
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 16 : 16,
//     },
//     sectionScroll: {
//       marginBottom: isTablet ? 36 : isLargePhone ? 20 : 20,
//       paddingLeft: isTablet ? 38 : isLargePhone ? 18 : 18,
//     },
//     sectionScroll2: {
//       // marginBottom: isTablet ? 22 : isLargePhone ? 8 : 8,
//       paddingLeft: isTablet ? 38 : isLargePhone ? 18 : 18,
//     },

//     // ============================================================
//     // 🪟 Modal Containers
//     // ============================================================
//     modalSection: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 18 : 18,
//       // maxWidth: isTablet ? 820 : 720,
//       alignSelf: 'center',
//       borderRadius: tokens.borderRadius.md,
//     },
//     modalSection2: {
//       width: '100%',
//       maxWidth: isTablet ? 820 : 720,
//       alignSelf: 'center',
//       borderRadius: tokens.borderRadius.md,
//     },
//     modalSection3: {
//       width: '100%',
//       paddingHorizontal: isTablet ? 38 : isLargePhone ? 18 : 18,
//       maxWidth: isTablet ? 820 : 720,
//       alignSelf: 'center',
//       borderRadius: tokens.borderRadius.md,
//     },

//     // ============================================================
//     // 💳 Card Styles (shadows, borders, background variants)
//     // ============================================================
//     cardStyles1: {
//       padding: isTablet ? 20 : isLargePhone ? 18 : 14,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xxxl,
//       backgroundColor: theme.colors.surface,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 0, height: 4},
//       // shadowOpacity: 0.15,
//       // shadowRadius: 8,
//       // elevation: 5,

//       // shadowColor: 'rgb(0, 0, 0)',
//       // shadowOffset: {width: 6, height: 9},
//       // shadowOpacity: 0.9,
//       // shadowRadius: 7,
//       // elevation: 6,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 8, height: 10},
//       // shadowOpacity: 0.5,
//       // shadowRadius: 5,
//       // elevation: 6,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 8, height: 9},
//       // shadowOpacity: 0.5,
//       // shadowRadius: 5,
//       // elevation: 6,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 4, height: 4},
//       // shadowOpacity: 0.3,
//       // shadowRadius: 7,
//       // elevation: 5,
//     },
//     cardStyles2: {
//       padding: isTablet ? 18 : isLargePhone ? 16 : 12,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.md,
//     },
//     cardStyles3: {
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     cardStyles4: {
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.md,
//     },
//     cardStyles5: {
//       padding: isTablet ? 20 : isLargePhone ? 18 : 14,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xxxl,
//       backgroundColor: theme.colors.surface,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 4, height: 4},
//       // shadowOpacity: 0.3,
//       // shadowRadius: 7,
//       // elevation: 5,
//     },

//     newsCard1: {
//       paddingVertical: isTablet ? 14 : isLargePhone ? 14 : 14,
//       paddingHorizontal: isTablet ? 16 : isLargePhone ? 16 : 16,
//       backgroundColor: theme.colors.surface,
//       marginBottom: isTablet ? 10 : isLargePhone ? 10 : 10,
//       borderRadius: tokens.borderRadius.lg,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       elevation: 10,
//       transform: [{scale: 1}],
//     },

//     // ============================================================
//     // 🏷️ Typography Styles
//     // ============================================================
//     header: {
//       paddingLeft: isTablet ? 24 : isLargePhone ? 18 : 20,
//       fontSize: font.heading,
//       fontWeight: tokens.fontWeight.bold,
//       color: theme.colors.foreground,
//     },
//     backContainer: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       width: isTablet ? 120 : 100,
//     },
//     backText: {
//       fontSize: font.md,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.button3,
//     },
//     sectionTitle: {
//       fontSize: font.lg,
//       fontWeight: tokens.fontWeight.bold,
//       color: theme.colors.foreground,
//       marginBottom: isTablet ? 10 : isLargePhone ? 10 : 10,
//       // textTransform: 'uppercase',
//     },
//     sectionTitle2: {
//       fontSize: font.md,
//       fontWeight: tokens.fontWeight.medium,
//       lineHeight: isTablet ? 26 : 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle3: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       lineHeight: isTablet ? 26 : 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle4: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.normal,
//       lineHeight: isTablet ? 26 : 24,
//       color: theme.colors.foreground,
//     },
//     sectionTitle5: {
//       fontSize: font.lg,
//       fontWeight: tokens.fontWeight.extraBold,
//       lineHeight: isTablet ? 28 : 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//       textTransform: 'uppercase',
//     },

//     // ============================================================
//     // 🧱 Content Containers + Titles
//     // ============================================================
//     styleContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: isTablet ? 14 : isLargePhone ? 12 : 10,
//       marginBottom: isTablet ? 26 : isLargePhone ? 22 : 18,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       paddingTop: isTablet ? 24 : isLargePhone ? 20 : 16,
//       paddingHorizontal: isTablet ? 24 : isLargePhone ? 20 : 16,
//       paddingBottom: isTablet ? 12 : isLargePhone ? 10 : 8,
//     },
//     title: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.foreground,
//       marginBottom: isTablet ? 14 : isLargePhone ? 12 : 10,
//     },
//     title2: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.foreground,
//       marginBottom: isTablet ? 14 : isLargePhone ? 12 : 10,
//     },
//     title3: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.foreground,
//       marginBottom: isTablet ? 8 : 6,
//       marginTop: isTablet ? 6 : 4,
//     },
//     titleBold: {
//       fontSize: font.lg,
//       fontWeight: tokens.fontWeight.extraBold,
//       marginBottom: -4,
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 🏷️ Labels + Subtext
//     // ============================================================
//     label: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: theme.colors.foreground,
//     },
//     label2: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.semiBold,
//       width: '25%',
//       color: theme.colors.foreground,
//     },
//     subLabel: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.semiBold,
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },
//     cardLabel: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: theme.colors.foreground,
//     },
//     cardSubLabel: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.semiBold,
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },

//     // ============================================================
//     // 🍔 Menus + List Sections
//     // ============================================================
//     menuContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: isTablet ? 14 : isLargePhone ? 10 : 8,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       paddingHorizontal: isTablet ? 22 : isLargePhone ? 18 : 14,
//     },
//     menuSection1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       paddingHorizontal: isTablet ? 12 : isLargePhone ? 10 : 8,
//       paddingVertical: isTablet ? 24 : isLargePhone ? 20 : 16,
//     },
//     menuSection2: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xxl,
//       paddingHorizontal: isTablet ? 32 : isLargePhone ? 28 : 24,
//       paddingVertical: isTablet ? 22 : isLargePhone ? 20 : 18,
//     },
//     menuSection3: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: isTablet ? 32 : isLargePhone ? 18 : 24,
//     },
//     menuLabel: {
//       fontSize: font.lg,
//       fontWeight: tokens.fontWeight.normal,
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 💊 Pill Elements
//     // ============================================================
//     labelContainer: {
//       paddingVertical: isTablet ? 10 : 8,
//       paddingHorizontal: isTablet ? 16 : 12,
//     },
//     labelContainer2: {
//       paddingHorizontal: isTablet ? 16 : 12,
//     },
//     labelContainer3: {
//       paddingVertical: isTablet ? 8 : 6,
//       paddingHorizontal: isTablet ? 16 : 12,
//     },
//     labelContainer4: {
//       backgroundColor: 'red',
//     },
//     pillContainer: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'flex-start',
//       width: '100%',
//     },
//     pill: {
//       backgroundColor: theme.colors.foreground,
//       paddingHorizontal: isTablet ? 22 : isLargePhone ? 20 : 18,
//       paddingVertical: isTablet ? 10 : isLargePhone ? 9 : 8,
//       borderRadius: 18,
//       marginRight: isTablet ? 10 : isLargePhone ? 8 : 6,
//     },
//     pill2: {
//       paddingHorizontal: isTablet ? 22 : isLargePhone ? 20 : 18,
//       paddingVertical: isTablet ? 10 : isLargePhone ? 9 : 8,
//       backgroundColor: theme.colors.pillDark2,
//       borderRadius: 18,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//       marginRight: isTablet ? 10 : isLargePhone ? 8 : 6,
//     },
//     pill3: {
//       backgroundColor: theme.colors.foreground,
//       paddingHorizontal: isTablet ? 22 : isLargePhone ? 20 : 18,
//       paddingVertical: isTablet ? 10 : isLargePhone ? 9 : 8,
//       borderRadius: 18,
//       marginRight: isTablet ? 10 : isLargePhone ? 8 : 6,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     pillText: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.background,
//     },
//     pillText2: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.button1,
//     },
//     pillFixedWidth: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       alignSelf: 'flex-start',
//       width: '32%',
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//     },
//     pillTextFixedWidth: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     pillFixedWidth2: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       alignSelf: 'flex-start',
//       width: '23%',
//     },
//     pillTextFixedWidth2: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.medium,
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },

//     // ============================================================
//     // 🔘 Buttons
//     // ============================================================
//     buttonHome: {
//       width: '90%',
//       maxWidth: isTablet ? 300 : 270,
//       paddingVertical: isTablet ? 18 : isLargePhone ? 16 : 14,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: isTablet ? 26 : isLargePhone ? 22 : 18,
//       alignItems: 'center',
//       backgroundColor: 'black',
//     },
//     buttonHomeText: {
//       fontSize: font.lg,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: '#fff',
//       textShadowColor: 'rgba(0,0,0,0.7)',
//       textShadowOffset: {width: 0, height: 1},
//       textShadowRadius: 3,
//     },
//     buttonPrimary: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: isTablet ? 16 : isLargePhone ? 14 : 12,
//       borderWidth: 1,
//     },
//     buttonPrimaryText: {
//       fontSize: font.md,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: theme.colors.buttonText1,
//     },
//     buttonSecondary: {
//       backgroundColor: theme.colors.button2,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: isTablet ? 16 : isLargePhone ? 14 : 12,
//       borderWidth: 1,
//     },
//     buttonSecondaryText: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: '#fff',
//     },
//     buttonTertiary: {
//       width: isTablet ? 110 : 90,
//       maxWidth: 186,
//       backgroundColor: theme.colors.surface2,
//       borderRadius: tokens.borderRadius.sm,
//       paddingVertical: isTablet ? 14 : isLargePhone ? 12 : 10,
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//     },
//     buttonTertiaryText: {
//       fontSize: font.sm,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: '#fff',
//     },
//     buttonPrimary4: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: isTablet ? 10 : isLargePhone ? 9 : 8,
//       borderWidth: 1,
//     },
//     buttonPrimaryText4: {
//       fontSize: font.xs,
//       fontWeight: tokens.fontWeight.semiBold,
//       color: theme.colors.buttonText1,
//     },

//     // ============================================================
//     // 🖼️ Image + Media
//     // ============================================================
//     image1: {
//       width: isTablet ? 108 : 92,
//       height: isTablet ? 108 : 92,
//       borderRadius: tokens.borderRadius.lg,
//       backgroundColor: '#eee',
//     },
//     image2: {
//       width: isTablet ? 108 : 92,
//       height: isTablet ? 108 : 92,
//       borderTopLeftRadius: isTablet ? 16 : 12,
//       borderTopRightRadius: isTablet ? 16 : 12,
//       backgroundColor: theme.colors.surface,
//     },
//     image3: {
//       width: isTablet ? 200 : 165,
//       height: isTablet ? 120 : 95,
//       borderRadius: tokens.borderRadius.lg,
//       backgroundColor: theme.colors.surface,
//     },
//     image4: {
//       // width: image4Size,
//       // height: image4Size,
//       width: 160,
//       height: 130,
//       backgroundColor: '#eee',
//       borderRadius: tokens.borderRadius.lg,
//     },
//     image5: {
//       width: '100%',
//       // height: isTablet ? 160 : isLargePhone ? 115 : 125,
//       height: isTablet ? 160 : isLargePhone ? 110 : isRegularPhone ? 115 : 105,
//       backgroundColor: theme.colors.surface,
//       // borderRadius: tokens.borderRadius.sm,
//       // borderBottomWidth: tokens.borderWidth.md,
//       // borderBottomColor: theme.colors.surfaceBorder,
//     },
//     image6: {
//       width: '100%',
//       backgroundColor: theme.colors.foreground,
//     },
//     image7: {
//       // width: image4Size,
//       // height: image4Size,
//       backgroundColor: theme.colors.surface,
//       width: '100%',
//       // height: isTablet ? 160 : isLargePhone ? 140 : 125,
//       height: isTablet ? 160 : isLargePhone ? 110 : isRegularPhone ? 115 : 105,
//     },
//     image8: {
//       // width: image4Size,
//       // height: image4Size,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.lg,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//       width: isTablet ? 160 : isLargePhone ? 120 : isRegularPhone ? 120 : 105,
//       // height: isTablet ? 160 : isLargePhone ? 175 : 145,
//       // height: isTablet ? 160 : isLargePhone ? 140 : 125,
//       // height: isTablet ? 160 : isLargePhone ? 155 : 145,
//       // height: isTablet ? 160 : isLargePhone ? 120 : isRegularPhone ? 115 : 105,
//       height: isTablet ? 160 : isLargePhone ? 115 : isRegularPhone ? 115 : 105,
//     },
//     image9: {
//       width: isTablet ? 189 : isLargePhone ? 189 : 166.5,
//       borderRadius: tokens.borderRadius.lg,
//       backgroundColor: theme.colors.surface,
//       overflow: 'hidden',
//       // borderColor: theme.colors.surfaceBorder,
//       // borderWidth: tokens.borderWidth.md,
//     },
//     image10: {
//       width: '100%',
//       height: isTablet ? 160 : isLargePhone ? 165 : 165,
//       backgroundColor: theme.colors.surface,
//       // borderRadius: tokens.borderRadius.sm,
//       borderBottomWidth: tokens.borderWidth.md,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     bgContainer1: {
//       height: isTablet ? 260 : isLargePhone ? 305 : 260,
//       borderRadius: tokens.borderRadius.xl,
//       overflow: 'hidden',
//       shadowColor: '#000',
//       shadowOpacity: 0.35,
//       shadowRadius: 20,
//       shadowOffset: {width: 0, height: 10},
//       elevation: 12,
//       backgroundColor: theme.colors.surface,
//       transform: [{scale: 1}],
//       marginBottom: 2,
//     },

//     // ============================================================
//     // 🧥 Outfit Cards + Lists
//     // ============================================================
//     outfitCard: {
//       // width: outfitCardSize,
//       // marginRight: isTablet ? 16 : isLargePhone ? 12 : 10,
//       marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
//       // alignItems: 'flex-start',
//       // borderRadius: tokens.borderRadius.lg,
//     },

//     outfitCard2: {
//       // width: isTablet ? 160 : isLargePhone ? 180 : 160,
//       width: isTablet ? 160 : isLargePhone ? 180 : 160,
//       marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
//       alignItems: 'flex-start',
//       backgroundColor: theme.colors.surface2,
//       overflow: 'hidden',
//       borderRadius: tokens.borderRadius.lg,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//     },

//     outfitCard3: {
//       // width: 220,
//       // width: 275,
//       // width: isTablet ? 275 : isLargePhone ? 275 : 230,
//       width: isTablet ? 275 : isLargePhone ? 235 : 230,
//       marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
//       alignItems: 'flex-start',
//       backgroundColor: theme.colors.surface,
//       overflow: 'hidden',
//       borderRadius: tokens.borderRadius.lg,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//     },

//     outfitCard4: {
//       width: isTablet ? 160 : isLargePhone ? 195 : isRegularPhone ? 184 : 165,
//       // marginRight: isTablet ? 16 : isLargePhone ? 12 : isRegularPhone ? 12 : 12,
//       alignItems: 'flex-start',
//       backgroundColor: theme.colors.surface,
//       overflow: 'hidden',
//       borderRadius: tokens.borderRadius.lg,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//     },

//     // ============================================================
//     // 🎙️ Prompt Input (Voice/Chat Bar)
//     // ============================================================
//     promptRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: '#1a1a1a',
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: isTablet ? 16 : 12,
//       width: '100%',
//     },
//     promptInput: {
//       flex: 1,
//       color: theme.colors.foreground,
//       fontSize: font.md,
//     },

//     // ============================================================
//     // ✍️ Utility + Miscellaneous
//     // ============================================================
//     hrLine: {
//       borderBottomWidth: 1,
//       borderColor: 'rgba(74, 74, 74, 0.37)',
//     },
//     boxShadowLight: {
//       shadowColor: 'rgb(0, 0, 0)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     boxShadowDark: {
//       shadowColor: 'rgb(73, 73, 73)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     missingDataMessage1: {
//       color: theme.colors.muted,
//       textAlign: 'left',
//       marginTop: 0,
//       lineHeight: 20,
//       maxWidth: isTablet ? 500 : 400,
//     },
//   });

//////////////////////////

// // src/styles/globalStyles.ts
// // ---------------------------------------------------------------------------
// // 🔹 Purpose:
// // Defines all global React Native styles shared across the app.
// // Provides consistent design primitives (spacing, radii, typography, etc.)
// // and responsive behavior across phones, Pro Max devices, and tablets.
// //
// // 🔹 Core Features:
// // - Uses Dimensions for static device breakpoints (phone / tablet).
// // - Imports design tokens (borderRadius, borderWidth, etc.) from tokens.ts.
// // - Pulls the current color palette from ThemeContext (light/dark).
// // - Centralizes card, button, text, image, and layout styles.
// //
// // 🔹 When to use:
// // Call `createGlobalStyles(theme)` inside a screen or component to
// // access unified styles: `const global = createGlobalStyles(theme)`
// // ---------------------------------------------------------------------------

// import {StyleSheet, Dimensions} from 'react-native';
// import {tokens} from './tokens/tokens';
// import type {Theme} from '../context/ThemeContext';
// import {fontScale, scale} from '../utils/scale';
// // import { useSafeAreaInsets } from 'react-native-safe-area-context';
// // const insets = useSafeAreaInsets();
// // screen: { paddingTop: insets.top, paddingBottom: insets.bottom + tokens.spacing.lg }

// // ---------------------------------------------------------------------------
// // 🧭 Device breakpoints
// // Determines device class once at load time. Used for static style tiers.
// // ---------------------------------------------------------------------------
// const {width: screenWidth} = Dimensions.get('window');
// const isTablet = screenWidth >= 768; // Tablets / iPads / large foldables
// const isLargePhone = screenWidth >= 430; // iPhone Pro Max & similar large phones

// // ---------------------------------------------------------------------------
// // 📐 Responsive constants
// // Defines adaptive spacing, padding, and element dimensions for each device tier.
// // These are static (computed once) for performance and predictability.
// // ---------------------------------------------------------------------------
// const responsivePadding = isTablet ? 38 : 20;
// const sectionMarginBottom = isTablet ? 32 : 24;

// const image1Width = isTablet ? 270 : 165;
// const image1Height = isTablet ? 150 : 95;
// const image2Width = isTablet ? 270 : 165;
// const image2Height = isTablet ? 150 : 95;
// const image4Size = isTablet ? 160 : 110;
// const outfitCardSize = isTablet ? 164 : 110;

// // ---------------------------------------------------------------------------
// // 🔤 Breakpoint-based typography tiers
// // Fonts never scale automatically with screen width — only through fixed tiers.
// // This keeps typography visually consistent (Apple-style design philosophy).
// // ---------------------------------------------------------------------------
// // const font = {
// //   xs: isTablet ? 14 : isLargePhone ? 13 : 12, // tiny captions
// //   sm: isTablet ? 15 : isLargePhone ? 14 : 13, // labels, metadata
// //   md: isTablet ? 17 : isLargePhone ? 16 : 15, // body text
// //   lg: isTablet ? 19 : isLargePhone ? 18 : 17, // section titles
// //   xl: isTablet ? 22 : isLargePhone ? 20 : 18, // large titles
// //   heading: isTablet ? 36 : isLargePhone ? 34 : 32, // hero headers
// // };

// // const font = {
// //   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
// //   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
// //   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
// //   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
// //   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
// //   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// // };
// const font = {
//   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
//   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
//   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
//   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
//   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
//   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// };

// // ---------------------------------------------------------------------------
// // 🎨 Global StyleSheet factory
// // Generates a complete theme-aware, responsive style map for your UI.
// // Each block is organized by functional category for clarity.
// // ---------------------------------------------------------------------------
// export const createGlobalStyles = (theme: Theme) =>
//   StyleSheet.create({
//     // ============================================================
//     // 🌎 Core Layout Containers
//     // ============================================================
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background, // entire screen background
//     },
//     container: {
//       paddingTop: 5,
//       paddingBottom: 60,
//       width: '100%',
//       alignSelf: 'center',
//       flexGrow: 1,
//     },
//     centeredSection: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center', // keeps sections centered on large devices
//     },

//     // ============================================================
//     // 🪟 Modal Containers
//     // ============================================================
//     modalSection: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection2: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection3: {
//       width: '100%',
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },

//     // ============================================================
//     // 💳 Card Styles (shadows, borders, background variants)
//     // ============================================================
//     cardStyles1: {
//       padding: 16,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//       // borderRadius: tokens.borderRadius['2xl'],
//       backgroundColor: theme.colors.surface,
//       // shadowColor: 'rgb(0, 0, 0)',
//       // shadowOffset: {width: 6, height: 9},
//       // shadowOpacity: 0.9,
//       // shadowRadius: 7,
//       // elevation: 6,

//       // shadowColor: '#000',
//       // shadowOffset: {width: 8, height: 10},
//       // shadowOpacity: 0.5,
//       // shadowRadius: 5,
//       // elevation: 6,
//     },
//     cardStyles2: {
//       padding: 14,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles3: {
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles4: {
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.md,
//     },

//     // ============================================================
//     // 🧩 Layout Sections
//     // ============================================================
//     section: {
//       marginBottom: sectionMarginBottom,
//       paddingHorizontal: responsivePadding,
//     },
//     section2: {
//       marginBottom: sectionMarginBottom,
//     },
//     section3: {
//       paddingHorizontal: responsivePadding,
//       marginTop: 20,
//       marginBottom: 20,
//     },
//     section4: {
//       paddingHorizontal: responsivePadding,
//     },
//     section5: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     section6: {
//       paddingHorizontal: responsivePadding,
//     },
//     sectionScroll: {
//       marginBottom: 30,
//       paddingLeft: responsivePadding,
//     },

//     // ============================================================
//     // 🏷️ Typography Styles
//     // ============================================================
//     header: {
//       paddingLeft: 20,
//       fontSize: font.heading,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//     },
//     backContainer: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       width: 100,
//     },
//     backText: {
//       fontSize: font.md,
//       fontWeight: '500',
//       color: theme.colors.button3,
//     },
//     sectionTitle: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 8,
//       textTransform: 'uppercase',
//     },
//     sectionTitle2: {
//       fontSize: font.md,
//       fontWeight: '700',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle3: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle4: {
//       fontSize: font.sm,
//       fontWeight: '400',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//     },
//     sectionTitle5: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//       textTransform: 'uppercase',
//     },

//     // ============================================================
//     // 🧱 Content Containers + Titles
//     // ============================================================
//     styleContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 10,
//       marginBottom: 20,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingTop: 18,
//       paddingHorizontal: 16,
//       paddingBottom: 8,
//     },
//     title: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title2: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title3: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 6,
//       marginTop: 4,
//     },
//     titleBold: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       marginBottom: -4,
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 🏷️ Labels + Subtext
//     // ============================================================
//     label: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     label2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       width: '25%',
//       color: theme.colors.foreground,
//     },
//     subLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },
//     cardLabel: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     cardSubLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },

//     // ============================================================
//     // 🍔 Menus + List Sections
//     // ============================================================
//     menuContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 8,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 16,
//     },
//     menuSection1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       paddingHorizontal: 8,
//       paddingVertical: 18,
//     },
//     menuSection2: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//       paddingVertical: 18,
//     },
//     menuSection3: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//     },
//     menuLabel: {
//       fontSize: font.lg,
//       fontWeight: '400',
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 💊 Pill Elements
//     // ============================================================
//     labelContainer: {
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//     },
//     labelContainer2: {
//       paddingHorizontal: 12,
//     },
//     labelContainer3: {
//       paddingVertical: 6,
//       paddingHorizontal: 12,
//     },
//     labelContainer4: {
//       backgroundColor: 'red',
//     },
//     pillContainer: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'flex-start',
//       width: '100%',
//     },
//     pill: {
//       backgroundColor: theme.colors.foreground,
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       borderRadius: 18,
//       marginRight: 8,
//     },
//     pill2: {
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       backgroundColor: theme.colors.pillDark2,
//       borderRadius: 18,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       marginRight: 8,
//     },
//     pillText: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.background,
//     },
//     pillFixedWidth: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       alignSelf: 'flex-start',
//       width: '32%',
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//     },
//     pillTextFixedWidth: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     pillFixedWidth2: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       alignSelf: 'flex-start',
//       width: '23%',
//     },
//     pillTextFixedWidth2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },

//     // ============================================================
//     // 🔘 Buttons
//     // ============================================================
//     buttonHome: {
//       width: '90%',
//       maxWidth: 270,
//       paddingVertical: 16,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//       alignItems: 'center',
//       backgroundColor: 'black',
//     },
//     buttonHomeText: {
//       fontSize: font.lg,
//       fontWeight: '600',
//       color: '#fff',
//       textShadowColor: 'rgba(0,0,0,0.7)',
//       textShadowOffset: {width: 0, height: 1},
//       textShadowRadius: 3,
//     },
//     buttonPrimary: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonPrimaryText: {
//       fontSize: font.md,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//     buttonSecondary: {
//       backgroundColor: theme.colors.button2,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonSecondaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonTertiary: {
//       width: 90,
//       maxWidth: 186,
//       backgroundColor: theme.colors.surface2,
//       borderRadius: tokens.borderRadius.sm,
//       paddingVertical: 12,
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//     },
//     buttonTertiaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonPrimary4: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 8,
//       borderWidth: 1,
//     },
//     buttonPrimaryText4: {
//       fontSize: font.xs,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },

//     // ============================================================
//     // 🖼️ Image + Media
//     // ============================================================
//     image1: {
//       width: 92,
//       height: 92,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: '#eee',
//     },
//     image2: {
//       width: image2Width,
//       height: image2Height,
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//       backgroundColor: theme.colors.surface,
//     },
//     image3: {
//       width: 165,
//       height: 95,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: theme.colors.surface,
//     },
//     image4: {
//       width: image4Size,
//       height: image4Size,
//       backgroundColor: '#eee',
//       borderRadius: tokens.borderRadius.md,
//     },
//     image5: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomWidth: tokens.borderWidth.md,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     image6: {
//       width: '100%',
//       backgroundColor: theme.colors.foreground,
//     },

//     // ============================================================
//     // 🧥 Outfit Cards + Lists
//     // ============================================================
//     outfitCard: {
//       width: outfitCardSize,
//       marginRight: 12,
//       alignItems: 'flex-start',
//     },

//     // ============================================================
//     // 🎙️ Prompt Input (Voice/Chat Bar)
//     // ============================================================
//     promptRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: '#1a1a1a',
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       width: '100%',
//     },
//     promptInput: {
//       flex: 1,
//       color: theme.colors.foreground,
//       fontSize: font.md,
//     },

//     // ============================================================
//     // ✍️ Utility + Miscellaneous
//     // ============================================================
//     hrLine: {
//       borderBottomWidth: 1,
//       borderColor: 'rgba(74, 74, 74, 0.37)',
//     },
//     boxShadowLight: {
//       shadowColor: 'rgb(0, 0, 0)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     boxShadowDark: {
//       shadowColor: 'rgb(73, 73, 73)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     missingDataMessage1: {
//       color: theme.colors.muted,
//       textAlign: 'left',
//       marginTop: 0,
//       lineHeight: 20,
//       maxWidth: 400,
//     },
//   });

// ///////////////////

// // src/styles/globalStyles.ts
// // ---------------------------------------------------------------------------
// // 🔹 Purpose:
// // Defines all global React Native styles shared across the app.
// // Provides consistent design primitives (spacing, radii, typography, etc.)
// // and responsive behavior across phones, Pro Max devices, and tablets.
// //
// // 🔹 Core Features:
// // - Uses Dimensions for static device breakpoints (phone / tablet).
// // - Imports design tokens (borderRadius, borderWidth, etc.) from tokens.ts.
// // - Pulls the current color palette from ThemeContext (light/dark).
// // - Centralizes card, button, text, image, and layout styles.
// //
// // 🔹 When to use:
// // Call `createGlobalStyles(theme)` inside a screen or component to
// // access unified styles: `const global = createGlobalStyles(theme)`
// // ---------------------------------------------------------------------------

// import {StyleSheet, Dimensions} from 'react-native';
// import {tokens} from './tokens/tokens';
// import type {Theme} from '../context/ThemeContext';
// import {fontScale, scale} from '../utils/scale';
// // import { useSafeAreaInsets } from 'react-native-safe-area-context';
// // const insets = useSafeAreaInsets();
// // screen: { paddingTop: insets.top, paddingBottom: insets.bottom + tokens.spacing.lg }

// // ---------------------------------------------------------------------------
// // 🧭 Device breakpoints
// // Determines device class once at load time. Used for static style tiers.
// // ---------------------------------------------------------------------------
// const {width: screenWidth} = Dimensions.get('window');
// const isTablet = screenWidth >= 768; // Tablets / iPads / large foldables
// const isLargePhone = screenWidth >= 430; // iPhone Pro Max & similar large phones

// // ---------------------------------------------------------------------------
// // 📐 Responsive constants
// // Defines adaptive spacing, padding, and element dimensions for each device tier.
// // These are static (computed once) for performance and predictability.
// // ---------------------------------------------------------------------------
// const responsivePadding = isTablet ? 38 : 20;
// const sectionMarginBottom = isTablet ? 32 : 24;

// const image1Width = isTablet ? 270 : 165;
// const image1Height = isTablet ? 150 : 95;
// const image2Width = isTablet ? 270 : 165;
// const image2Height = isTablet ? 150 : 95;
// const image4Size = isTablet ? 160 : 110;
// const outfitCardSize = isTablet ? 164 : 110;

// // ---------------------------------------------------------------------------
// // 🔤 Breakpoint-based typography tiers
// // Fonts never scale automatically with screen width — only through fixed tiers.
// // This keeps typography visually consistent (Apple-style design philosophy).
// // ---------------------------------------------------------------------------
// // const font = {
// //   xs: isTablet ? 14 : isLargePhone ? 13 : 12, // tiny captions
// //   sm: isTablet ? 15 : isLargePhone ? 14 : 13, // labels, metadata
// //   md: isTablet ? 17 : isLargePhone ? 16 : 15, // body text
// //   lg: isTablet ? 19 : isLargePhone ? 18 : 17, // section titles
// //   xl: isTablet ? 22 : isLargePhone ? 20 : 18, // large titles
// //   heading: isTablet ? 36 : isLargePhone ? 34 : 32, // hero headers
// // };

// // const font = {
// //   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
// //   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
// //   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
// //   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
// //   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
// //   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// // };
// const font = {
//   xs: isTablet ? tokens.fontSize.xs + 1 : tokens.fontSize.xs,
//   sm: isTablet ? tokens.fontSize.sm + 1 : tokens.fontSize.sm,
//   md: isTablet ? tokens.fontSize.base + 1 : tokens.fontSize.base,
//   lg: isTablet ? tokens.fontSize.lg + 1 : tokens.fontSize.lg,
//   xl: isTablet ? tokens.fontSize.xl + 2 : tokens.fontSize.xl,
//   heading: isTablet ? tokens.fontSize['3xl'] : tokens.fontSize['2.5xl'],
// };

// // ---------------------------------------------------------------------------
// // 🎨 Global StyleSheet factory
// // Generates a complete theme-aware, responsive style map for your UI.
// // Each block is organized by functional category for clarity.
// // ---------------------------------------------------------------------------
// export const createGlobalStyles = (theme: Theme) =>
//   StyleSheet.create({
//     // ============================================================
//     // 🌎 Core Layout Containers
//     // ============================================================
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background, // entire screen background
//     },
//     container: {
//       paddingTop: 5,
//       paddingBottom: 60,
//       width: '100%',
//       alignSelf: 'center',
//       flexGrow: 1,
//     },
//     centeredSection: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center', // keeps sections centered on large devices
//     },

//     // ============================================================
//     // 🪟 Modal Containers
//     // ============================================================
//     modalSection: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection2: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection3: {
//       width: '100%',
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },

//     // ============================================================
//     // 💳 Card Styles (shadows, borders, background variants)
//     // ============================================================
//     cardStyles1: {
//       padding: 16,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//       backgroundColor: theme.colors.surface,
//     },
//     cardStyles2: {
//       padding: 14,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles3: {
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles4: {
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.md,
//     },

//     // ============================================================
//     // 🧩 Layout Sections
//     // ============================================================
//     section: {
//       marginBottom: sectionMarginBottom,
//       paddingHorizontal: responsivePadding,
//     },
//     section2: {
//       marginBottom: sectionMarginBottom,
//     },
//     section3: {
//       paddingHorizontal: responsivePadding,
//       marginTop: 20,
//       marginBottom: 20,
//     },
//     section4: {
//       paddingHorizontal: responsivePadding,
//     },
//     section5: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     section6: {
//       paddingHorizontal: responsivePadding,
//     },
//     sectionScroll: {
//       marginBottom: 30,
//       paddingLeft: responsivePadding,
//     },

//     // ============================================================
//     // 🏷️ Typography Styles
//     // ============================================================
//     header: {
//       paddingLeft: 20,
//       fontSize: font.heading,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//     },
//     backContainer: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       width: 100,
//     },
//     backText: {
//       fontSize: font.md,
//       fontWeight: '500',
//       color: theme.colors.button3,
//     },
//     sectionTitle: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 8,
//       textTransform: 'uppercase',
//     },
//     sectionTitle2: {
//       fontSize: font.md,
//       fontWeight: '700',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle3: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle4: {
//       fontSize: font.sm,
//       fontWeight: '400',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//     },
//     sectionTitle5: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//       textTransform: 'uppercase',
//     },

//     // ============================================================
//     // 🧱 Content Containers + Titles
//     // ============================================================
//     styleContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 10,
//       marginBottom: 20,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingTop: 18,
//       paddingHorizontal: 16,
//       paddingBottom: 8,
//     },
//     title: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title2: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title3: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 6,
//       marginTop: 4,
//     },
//     titleBold: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       marginBottom: -4,
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 🏷️ Labels + Subtext
//     // ============================================================
//     label: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     label2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       width: '25%',
//       color: theme.colors.foreground,
//     },
//     subLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },
//     cardLabel: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     cardSubLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },

//     // ============================================================
//     // 🍔 Menus + List Sections
//     // ============================================================
//     menuContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 8,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 16,
//     },
//     menuSection1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       paddingHorizontal: 8,
//       paddingVertical: 18,
//     },
//     menuSection2: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//       paddingVertical: 18,
//     },
//     menuSection3: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//     },
//     menuLabel: {
//       fontSize: font.lg,
//       fontWeight: '400',
//       color: theme.colors.foreground,
//     },

//     // ============================================================
//     // 💊 Pill Elements
//     // ============================================================
//     labelContainer: {
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//     },
//     labelContainer2: {
//       paddingHorizontal: 12,
//     },
//     labelContainer3: {
//       paddingVertical: 6,
//       paddingHorizontal: 12,
//     },
//     labelContainer4: {
//       backgroundColor: 'red',
//     },
//     pillContainer: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'flex-start',
//       width: '100%',
//     },
//     pill: {
//       backgroundColor: theme.colors.foreground,
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       borderRadius: 18,
//       marginRight: 8,
//     },
//     pill2: {
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       backgroundColor: theme.colors.pillDark2,
//       borderRadius: 18,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       marginRight: 8,
//     },
//     pillText: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.background,
//     },
//     pillFixedWidth: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       alignSelf: 'flex-start',
//       width: '32%',
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//     },
//     pillTextFixedWidth: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     pillFixedWidth2: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       alignSelf: 'flex-start',
//       width: '23%',
//     },
//     pillTextFixedWidth2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },

//     // ============================================================
//     // 🔘 Buttons
//     // ============================================================
//     buttonHome: {
//       width: '90%',
//       maxWidth: 270,
//       paddingVertical: 16,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//       alignItems: 'center',
//       backgroundColor: 'black',
//     },
//     buttonHomeText: {
//       fontSize: font.lg,
//       fontWeight: '600',
//       color: '#fff',
//       textShadowColor: 'rgba(0,0,0,0.7)',
//       textShadowOffset: {width: 0, height: 1},
//       textShadowRadius: 3,
//     },
//     buttonPrimary: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonPrimaryText: {
//       fontSize: font.md,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//     buttonSecondary: {
//       backgroundColor: theme.colors.button2,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonSecondaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonTertiary: {
//       width: 90,
//       maxWidth: 186,
//       backgroundColor: theme.colors.surface2,
//       borderRadius: tokens.borderRadius.sm,
//       paddingVertical: 12,
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//     },
//     buttonTertiaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonPrimary4: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 8,
//       borderWidth: 1,
//     },
//     buttonPrimaryText4: {
//       fontSize: font.xs,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },

//     // ============================================================
//     // 🖼️ Image + Media
//     // ============================================================
//     image1: {
//       width: 92,
//       height: 92,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: '#eee',
//     },
//     image2: {
//       width: image2Width,
//       height: image2Height,
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//       backgroundColor: theme.colors.surface,
//     },
//     image3: {
//       width: 165,
//       height: 95,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: theme.colors.surface,
//     },
//     image4: {
//       width: image4Size,
//       height: image4Size,
//       backgroundColor: '#eee',
//       borderRadius: tokens.borderRadius.md,
//     },
//     image5: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomWidth: tokens.borderWidth.md,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     image6: {
//       width: '100%',
//       backgroundColor: theme.colors.foreground,
//     },

//     // ============================================================
//     // 🧥 Outfit Cards + Lists
//     // ============================================================
//     outfitCard: {
//       width: outfitCardSize,
//       marginRight: 12,
//       alignItems: 'flex-start',
//     },

//     // ============================================================
//     // 🎙️ Prompt Input (Voice/Chat Bar)
//     // ============================================================
//     promptRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: '#1a1a1a',
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       width: '100%',
//     },
//     promptInput: {
//       flex: 1,
//       color: theme.colors.foreground,
//       fontSize: font.md,
//     },

//     // ============================================================
//     // ✍️ Utility + Miscellaneous
//     // ============================================================
//     hrLine: {
//       borderBottomWidth: 1,
//       borderColor: 'rgba(74, 74, 74, 0.37)',
//     },
//     boxShadowLight: {
//       shadowColor: 'rgb(0, 0, 0)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     boxShadowDark: {
//       shadowColor: 'rgb(73, 73, 73)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     missingDataMessage1: {
//       color: theme.colors.muted,
//       textAlign: 'left',
//       marginTop: 0,
//       lineHeight: 20,
//       maxWidth: 400,
//     },
//   });

//////////////////////

// import {StyleSheet, Dimensions} from 'react-native';
// import {tokens} from './tokens/tokens';
// import type {Theme} from '../context/ThemeContext';

// const {width: screenWidth} = Dimensions.get('window');
// const isTablet = screenWidth >= 768;
// const isLargePhone = screenWidth >= 430; // iPhone Pro Max breakpoint

// // 📐 Responsive constants
// const responsivePadding = isTablet ? 38 : 20;
// const sectionMarginBottom = isTablet ? 32 : 24;
// const image1Width = isTablet ? 270 : 165;
// const image1Height = isTablet ? 150 : 95;
// const image2Width = isTablet ? 270 : 165;
// const image2Height = isTablet ? 150 : 95;
// const image4Size = isTablet ? 160 : 110;
// const outfitCardSize = isTablet ? 164 : 110;

// // ✅ Breakpoint-based typography — no scaling, just gentle tiering
// const font = {
//   xs: isTablet ? 14 : isLargePhone ? 13 : 12,
//   sm: isTablet ? 15 : isLargePhone ? 14 : 13,
//   md: isTablet ? 17 : isLargePhone ? 16 : 15,
//   lg: isTablet ? 19 : isLargePhone ? 18 : 17,
//   xl: isTablet ? 22 : isLargePhone ? 20 : 18,
//   heading: isTablet ? 36 : isLargePhone ? 34 : 32,
// };

// export const createGlobalStyles = (theme: Theme) =>
//   StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     container: {
//       paddingTop: 20,
//       paddingBottom: 60,
//       width: '100%',
//       alignSelf: 'center',
//       flexGrow: 1,
//     },
//     centeredSection: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//     },
//     modalSection: {
//       width: '100%',
//       backgroundColor: theme.colors.surface,
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection2: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     modalSection3: {
//       width: '100%',
//       paddingHorizontal: responsivePadding,
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     cardStyles1: {
//       padding: 16,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//       backgroundColor: theme.colors.surface,
//     },
//     cardStyles2: {
//       padding: 14,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles3: {
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.xl,
//     },
//     cardStyles4: {
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       borderWidth: 1,
//       borderColor: theme.colors.surfaceBorder,
//       borderRadius: tokens.borderRadius.md,
//     },
//     section: {
//       marginBottom: sectionMarginBottom,
//       paddingHorizontal: responsivePadding,
//     },
//     section2: {
//       marginBottom: sectionMarginBottom,
//     },
//     section3: {
//       paddingHorizontal: responsivePadding,
//       marginTop: 20,
//       marginBottom: 20,
//     },
//     section4: {
//       paddingHorizontal: responsivePadding,
//     },
//     section5: {
//       width: '100%',
//       maxWidth: 720,
//       alignSelf: 'center',
//       borderRadius: 25,
//     },
//     section6: {
//       paddingHorizontal: responsivePadding,
//     },
//     sectionScroll: {
//       marginBottom: 30,
//       paddingLeft: responsivePadding,
//     },
//     header: {
//       paddingLeft: 20,
//       fontSize: font.heading,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//     },
//     backContainer: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       width: 100,
//     },
//     backText: {
//       fontSize: font.md,
//       fontWeight: '500',
//       color: theme.colors.button3,
//     },
//     sectionTitle: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 8,
//       textTransform: 'uppercase',
//     },
//     sectionTitle2: {
//       fontSize: font.md,
//       fontWeight: '700',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle3: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//     },
//     sectionTitle4: {
//       fontSize: font.sm,
//       fontWeight: '400',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//     },
//     sectionTitle5: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       lineHeight: 24,
//       color: theme.colors.foreground,
//       marginBottom: 2,
//       textTransform: 'uppercase',
//     },
//     styleContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 10,
//       marginBottom: 20,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingTop: 18,
//       paddingHorizontal: 16,
//       paddingBottom: 8,
//     },
//     title: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title2: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 12,
//     },
//     title3: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       marginBottom: 6,
//       marginTop: 4,
//     },
//     titleBold: {
//       fontSize: font.lg,
//       fontWeight: '800',
//       marginBottom: -4,
//       color: theme.colors.foreground,
//     },
//     label: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     label2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       width: '25%',
//       color: theme.colors.foreground,
//     },
//     subLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },
//     cardLabel: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//     },
//     cardSubLabel: {
//       fontSize: font.xs,
//       fontWeight: '500',
//       marginTop: 2,
//       color: theme.colors.foreground2,
//     },
//     menuContainer1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       marginTop: 8,
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 16,
//     },
//     menuSection1: {
//       flexDirection: 'column',
//       justifyContent: 'center',
//       paddingHorizontal: 8,
//       paddingVertical: 18,
//     },
//     menuSection2: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//       paddingVertical: 18,
//     },
//     menuSection3: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 26,
//     },
//     menuLabel: {
//       fontSize: font.lg,
//       fontWeight: '400',
//       color: theme.colors.foreground,
//     },
//     labelContainer: {
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//     },
//     labelContainer2: {
//       paddingHorizontal: 12,
//     },
//     labelContainer3: {
//       paddingVertical: 6,
//       paddingHorizontal: 12,
//     },
//     labelContainer4: {
//       backgroundColor: 'red',
//     },
//     pillContainer: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       justifyContent: 'flex-start',
//       width: '100%',
//     },
//     pill: {
//       backgroundColor: theme.colors.foreground,
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       borderRadius: 18,
//       marginRight: 8,
//     },
//     pill2: {
//       paddingHorizontal: 18,
//       paddingVertical: 9,
//       backgroundColor: theme.colors.pillDark2,
//       borderRadius: 18,
//       borderWidth: tokens.borderWidth.md,
//       borderColor: theme.colors.surfaceBorder,
//       marginRight: 8,
//     },
//     pillText: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.background,
//     },
//     pillFixedWidth: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       alignSelf: 'flex-start',
//       width: '32%',
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//     },
//     pillTextFixedWidth: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     pillFixedWidth2: {
//       backgroundColor: theme.colors.surface,
//       paddingVertical: 9,
//       borderRadius: 18,
//       shadowOffset: {width: 0, height: 6},
//       shadowOpacity: 0.1,
//       shadowRadius: 12,
//       elevation: 5,
//       alignSelf: 'flex-start',
//       width: '23%',
//     },
//     pillTextFixedWidth2: {
//       fontSize: font.sm,
//       fontWeight: '500',
//       color: theme.colors.foreground,
//       textAlign: 'center',
//     },
//     buttonHome: {
//       width: '90%',
//       maxWidth: 270,
//       paddingVertical: 16,
//       borderRadius: tokens.borderRadius.md,
//       marginBottom: 20,
//       alignItems: 'center',
//       backgroundColor: 'black',
//     },
//     buttonHomeText: {
//       fontSize: font.lg,
//       fontWeight: '600',
//       color: '#fff',
//       textShadowColor: 'rgba(0,0,0,0.7)',
//       textShadowOffset: {width: 0, height: 1},
//       textShadowRadius: 3,
//     },
//     buttonPrimary: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonPrimaryText: {
//       fontSize: font.md,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//     buttonSecondary: {
//       backgroundColor: theme.colors.button2,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 13,
//       borderWidth: 1,
//     },
//     buttonSecondaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonTertiary: {
//       width: 90,
//       maxWidth: 186,
//       backgroundColor: theme.colors.surface2,
//       borderRadius: tokens.borderRadius.sm,
//       paddingVertical: 12,
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//     },
//     buttonTertiaryText: {
//       fontSize: font.sm,
//       fontWeight: '600',
//       color: '#fff',
//     },
//     buttonPrimary4: {
//       backgroundColor: theme.colors.button1,
//       borderRadius: tokens.borderRadius['2xl'],
//       alignItems: 'center',
//       justifyContent: 'center',
//       shadowColor: '#000',
//       shadowOffset: {width: 0, height: 1},
//       shadowOpacity: 0.1,
//       shadowRadius: 4,
//       elevation: 2,
//       borderColor: theme.colors.surfaceBorder,
//       paddingVertical: 8,
//       borderWidth: 1,
//     },
//     buttonPrimaryText4: {
//       fontSize: font.xs,
//       fontWeight: '600',
//       color: theme.colors.buttonText1,
//     },
//     image1: {
//       width: 92,
//       height: 92,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: '#eee',
//     },
//     image2: {
//       width: image2Width,
//       height: image2Height,
//       borderTopLeftRadius: 12,
//       borderTopRightRadius: 12,
//       backgroundColor: theme.colors.surface,
//     },
//     image3: {
//       width: 165,
//       height: 95,
//       borderRadius: tokens.borderRadius.md,
//       backgroundColor: theme.colors.surface,
//     },
//     image4: {
//       width: image4Size,
//       height: image4Size,
//       backgroundColor: '#eee',
//       borderRadius: tokens.borderRadius.md,
//     },
//     image5: {
//       width: '100%',
//       height: 120,
//       backgroundColor: theme.colors.surface,
//       borderBottomWidth: tokens.borderWidth.md,
//       borderBottomColor: theme.colors.surfaceBorder,
//     },
//     image6: {
//       width: '100%',
//       backgroundColor: theme.colors.foreground,
//     },
//     outfitCard: {
//       width: outfitCardSize,
//       marginRight: 12,
//       alignItems: 'flex-start',
//     },
//     promptRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       backgroundColor: '#1a1a1a',
//       borderRadius: tokens.borderRadius.md,
//       paddingHorizontal: 12,
//       width: '100%',
//     },
//     promptInput: {
//       flex: 1,
//       color: theme.colors.foreground,
//       fontSize: font.md,
//     },
//     hrLine: {
//       borderBottomWidth: 1,
//       borderColor: 'rgba(74, 74, 74, 0.37)',
//     },
//     boxShadowLight: {
//       shadowColor: 'rgb(0, 0, 0)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     boxShadowDark: {
//       shadowColor: 'rgb(73, 73, 73)',
//       shadowOffset: {width: 10, height: 8},
//       shadowOpacity: 0.5,
//       shadowRadius: 7,
//       elevation: 6,
//     },
//     missingDataMessage1: {
//       color: theme.colors.muted,
//       textAlign: 'left',
//       marginTop: 0,
//       lineHeight: 20,
//       maxWidth: 400,
//     },
//   });
