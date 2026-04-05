import React, {useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Switch,
  Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAppTheme} from '../context/ThemeContext';
import BackHeader from '../components/Backheader/Backheader';
import {useAuth0} from 'react-native-auth0';
import {useStyleProfile} from '../hooks/useStyleProfile';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';

type Props = {navigate: (screen: string) => void};

const h = (type: string) =>
  ReactNativeHapticFeedback.trigger(type, {
    enableVibrateFallback: true,
    ignoreAndroidSystemSettings: false,
  });

const STORAGE_KEY = 'userMeasurements';

const fieldMap: Record<string, string> = {
  Weight: 'weight',
  Chest: 'chest',
  Waist: 'waist',
  Inseam: 'inseam',
  'Shoe Size': 'shoe_size',
  Hip: 'hip',
  'Shoulder Width': 'shoulder_width',
};

export default function MeasurementsScreen({navigate}: Props) {
  const {theme} = useAppTheme();
  const colors = theme.colors;
  const globalStyles = useGlobalStyles();
  const {user} = useAuth0();
  const userId = user?.sub || '';
  const {updateProfile, styleProfile} = useStyleProfile(userId);

  const insets = useSafeAreaInsets();

  const styles = StyleSheet.create({
    screen: {flex: 1, backgroundColor: theme.colors.background},
    unitRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    unitTextContainer: {flex: 1, justifyContent: 'center'},
    switchContainer: {justifyContent: 'center', marginBottom: 8},
    input: {
      borderWidth: tokens.borderWidth.hairline,
      borderRadius: tokens.borderRadius.md,
      padding: 10,
      marginBottom: 15,
      fontSize: 17,
      backgroundColor: theme.colors.input2,
    },
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [unitPreference, setUnitPreference] = useState<'imperial' | 'metric'>(
    'imperial',
  );

  const [feet, setFeet] = useState('');
  const [inches, setInches] = useState('');
  const [centimeters, setCentimeters] = useState('');
  const [heightCm, setHeightCm] = useState<number | null>(null);

  useEffect(() => {
    if (!styleProfile) return;

    const unit =
      styleProfile.unit_preference === 'metric' ? 'metric' : 'imperial';
    setUnitPreference(unit);

    const initialValues: Record<string, string> = {};
    for (const [label, field] of Object.entries(fieldMap)) {
      const value = styleProfile[field];
      if (value !== undefined && value !== null) {
        initialValues[label] = value.toString();
      }
    }
    setValues(initialValues);

    const cm = styleProfile.height;
    if (cm && typeof cm === 'number') {
      setHeightCm(cm);
      setCentimeters(cm.toString());
      const totalInches = Math.round(cm / 2.54);
      const ft = Math.floor(totalInches / 12);
      const inch = totalInches % 12;
      setFeet(ft.toString());
      setInches(inch.toString());
    }
  }, [styleProfile]);

  // ✅ Local-only change handler (no DB write on every keystroke)
  const handleChange = (label: string, input: string) => {
    const cleaned = input.replace(/[^0-9.]/g, '');
    setValues(prev => ({...prev, [label]: cleaned}));
  };

  // ✅ Commit to DB only when editing ends
  const commitChange = (label: string) => {
    const dbField = fieldMap[label];
    if (!dbField) return;
    const rawValue = values[label];
    if (!rawValue) return;

    const isDecimal = label === 'Shoe Size';
    const numericValue = isDecimal
      ? parseFloat(rawValue)
      : parseInt(rawValue, 10);
    if (!isNaN(numericValue)) {
      updateProfile(dbField, numericValue);
    }
  };

  // ✅ Height handlers updated to only commit onBlur
  const handleFeetChange = (val: string) => {
    const ft = val.replace(/[^0-9]/g, '');
    setFeet(ft);
  };

  const commitFeet = () => {
    const inch = parseInt(inches || '0');
    const height = Math.round((parseInt(feet || '0') * 12 + inch) * 2.54);
    setHeightCm(height);
    setCentimeters(height.toString());
    updateProfile('height', height);
  };

  const handleInchesChange = (val: string) => {
    const inch = val.replace(/[^0-9]/g, '');
    setInches(inch);
  };

  const commitInches = () => {
    const ft = parseInt(feet || '0');
    const height = Math.round((ft * 12 + parseInt(inches || '0')) * 2.54);
    setHeightCm(height);
    setCentimeters(height.toString());
    updateProfile('height', height);
  };

  const handleCentimetersChange = (val: string) => {
    const cm = val.replace(/[^0-9]/g, '');
    setCentimeters(cm);
  };

  const commitCentimeters = () => {
    const height = parseInt(centimeters || '0');
    setHeightCm(height);
    const totalInches = Math.round(height / 2.54);
    const ft = Math.floor(totalInches / 12);
    const inch = totalInches % 12;
    setFeet(ft.toString());
    setInches(inch.toString());
    updateProfile('height', height);
  };

  const toggleUnits = () => {
    h('selection');

    const newUnit = unitPreference === 'imperial' ? 'metric' : 'imperial';
    const convertedValues: Record<string, string> = {...values};

    for (const label of Object.keys(fieldMap)) {
      const val = values[label];
      if (!val) continue;

      const numeric = parseFloat(val);
      if (isNaN(numeric)) continue;
      if (label === 'Shoe Size') continue;

      if (newUnit === 'metric') {
        convertedValues[label] =
          label === 'Weight'
            ? Math.round(numeric / 2.20462).toString()
            : Math.round(numeric * 2.54).toString();
      } else {
        convertedValues[label] =
          label === 'Weight'
            ? Math.round(numeric * 2.20462).toString()
            : Math.round(numeric / 2.54).toString();
      }
    }

    if (heightCm) {
      if (newUnit === 'metric') {
        setCentimeters(heightCm.toString());
      } else {
        const totalInches = Math.round(heightCm / 2.54);
        const ft = Math.floor(totalInches / 12);
        const inch = totalInches % 12;
        setFeet(ft.toString());
        setInches(inch.toString());
      }
    }

    setUnitPreference(newUnit);
    setValues(convertedValues);
    updateProfile('unit_preference', newUnit);
  };

  return (
    <View
      style={[
        globalStyles.container,
        {backgroundColor: theme.colors.background},
      ]}>
      <View
        style={{
          height: insets.top + 60, // ⬅️ 56 is about the old navbar height
          backgroundColor: theme.colors.background, // same tone as old nav
        }}
      />
      <Text style={[globalStyles.header, {color: theme.colors.primary}]}>
        Measurements
      </Text>

      <ScrollView>
        <View style={globalStyles.section4}>
          <View style={globalStyles.backContainer}>
            <AppleTouchFeedback
              hapticStyle="impactLight"
              onPress={() => navigate('StyleProfileScreen')}>
              <BackHeader
                title=""
                onBack={() => navigate('StyleProfileScreen')}
              />
            </AppleTouchFeedback>
            <Text style={globalStyles.backText}>Back</Text>
          </View>

          <View style={globalStyles.centeredSection}>
            <View
              style={[
                globalStyles.styleContainer1,

                {borderWidth: tokens.borderWidth.hairline},
              ]}>
              <View style={styles.unitRow}>
                <View style={styles.unitTextContainer}>
                  <Text
                    style={[
                      globalStyles.sectionTitle,
                      {color: colors.foreground},
                    ]}>
                    Units: {unitPreference === 'imperial' ? 'in/lbs' : 'cm/kg'}
                  </Text>
                </View>
                <View style={styles.switchContainer}>
                  <Switch
                    value={unitPreference === 'metric'}
                    onValueChange={toggleUnits}
                    trackColor={{false: colors.muted, true: colors.button1}}
                  />
                </View>
              </View>
            </View>
          </View>

          <View style={globalStyles.section5}>
            <Text
              style={[globalStyles.sectionTitle4, {color: colors.foreground}]}>
              Fill out your body measurements to tailor fit suggestions:
            </Text>

            <View style={[globalStyles.styleContainer1]}>
              <Text
                style={[
                  globalStyles.title,
                  {color: colors.foreground, marginBottom: 10},
                ]}>
                Height {unitPreference === 'imperial' ? '(ft/in)' : '(cm)'}
              </Text>

              {unitPreference === 'imperial' ? (
                <View style={{flexDirection: 'row', gap: 0}}>
                  <View style={{flex: 1, marginRight: 10}}>
                    <TextInput
                      placeholder="ft"
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.input,
                        {
                          borderColor: theme.colors.inputBorder,
                          color: colors.foreground,
                        },
                      ]}
                      keyboardType="number-pad"
                      value={feet}
                      onChangeText={handleFeetChange}
                      onBlur={commitFeet}
                    />
                  </View>
                  <View style={{flex: 1}}>
                    <TextInput
                      placeholder="in"
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.input,
                        {
                          borderColor: theme.colors.inputBorder,
                          color: colors.foreground,
                        },
                      ]}
                      keyboardType="number-pad"
                      value={inches}
                      onChangeText={handleInchesChange}
                      onBlur={commitInches}
                    />
                  </View>
                </View>
              ) : (
                <TextInput
                  placeholder="cm"
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.input,
                    {
                      borderColor: theme.colors.inputBorder,
                      color: colors.foreground,
                    },
                  ]}
                  keyboardType="number-pad"
                  value={centimeters}
                  onChangeText={handleCentimetersChange}
                  onBlur={commitCentimeters}
                />
              )}

              {Object.keys(fieldMap).map(label => {
                const unit =
                  label === 'Shoe Size'
                    ? ''
                    : label === 'Weight'
                    ? unitPreference === 'metric'
                      ? ' (kg)'
                      : ' (lbs)'
                    : unitPreference === 'metric'
                    ? ' (cm)'
                    : ' (in)';
                return (
                  <View key={label}>
                    <Text
                      style={[
                        globalStyles.title,
                        {
                          color: colors.foreground,
                          fontSize: 16,
                          fontWeight: '600',
                          marginBottom: 10,
                        },
                      ]}>
                      {label}
                      {unit}
                    </Text>
                    <TextInput
                      placeholder={label}
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.input,
                        {
                          borderColor: theme.colors.inputBorder,
                          color: colors.foreground,
                        },
                      ]}
                      keyboardType={
                        label === 'Shoe Size' ? 'decimal-pad' : 'number-pad'
                      }
                      value={values[label] || ''}
                      onChangeText={val => handleChange(label, val)}
                      onBlur={() => commitChange(label)}
                    />
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
