import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {useAppTheme} from '../../context/ThemeContext';
import {tokens} from '../../styles/tokens/tokens';
import {Trip, WeatherCondition} from '../../types/trips';
import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

const WEATHER_ICONS: Record<WeatherCondition, string> = {
  sunny: 'wb-sunny',
  'partly-cloudy': 'wb-cloudy',
  cloudy: 'cloud',
  rainy: 'grain',
  snowy: 'ac-unit',
  windy: 'air',
};

type Props = {
  trip: Trip;
  onPress: () => void;
  onDelete: () => void;
};

const TripCard = ({trip, onPress, onDelete}: Props) => {
  const {theme} = useAppTheme();

  const weather = trip.weather ?? [];

  const temps = weather.map(w => ({high: w.highF, low: w.lowF}));
  const maxHigh =
    temps.length > 0 ? Math.max(...temps.map(t => t.high)) : 70;
  const minLow = temps.length > 0 ? Math.min(...temps.map(t => t.low)) : 50;

  const conditionCounts: Record<string, number> = {};
  weather.forEach(w => {
    conditionCounts[w.condition] = (conditionCounts[w.condition] || 0) + 1;
  });
  const dominantCondition =
    (Object.entries(conditionCounts).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0] as WeatherCondition) || 'partly-cloudy';

  const start = new Date(trip.startDate + 'T00:00:00');
  const end = new Date(trip.endDate + 'T00:00:00');
  const formatDate = (d: Date) =>
    d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  const dateRange = `${formatDate(start)} – ${formatDate(end)}`;

  const numOutfits = trip.capsule?.outfits?.length ?? 0;
  const backupCount = trip.capsule?.tripBackupKit?.length ?? 0;
  const numItems =
    (trip.capsule?.packingList ?? []).reduce((sum, g) => sum + (g.items?.length ?? 0), 0)
    + backupCount;
  const capsuleStatus = trip.capsule
    ? `${numOutfits} looks · ${numItems} items`
    : 'No capsule yet';

  const styles = StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: tokens.borderRadius.xl,
      padding: tokens.spacing.lg,
      marginBottom: tokens.spacing.md,
      borderWidth: tokens.borderWidth.hairline,
      borderColor: theme.colors.surfaceBorder,
    },
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    destination: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.foreground,
      marginBottom: 4,
      flex: 1,
    },
    deleteBtn: {
      padding: 6,
      backgroundColor: 'black',
      borderRadius: 50,
      borderWidth: tokens.borderWidth.hairline
    },
    dateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 14,
    },
    dateText: {
      fontSize: 14,
      color: theme.colors.foreground2,
      fontWeight: '500',
    },
    bottomRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    weatherBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'black',
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: tokens.borderRadius.lg,
    },
    tempText: {
      fontSize: 13,
      fontWeight: '600',
      color: 'white',
    },
    capsuleText: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.foreground2,
    },
  });

  return (
    <AppleTouchFeedback onPress={onPress} hapticStyle="impactLight">
      <View style={styles.card}>
        <View style={styles.topRow}>
          <Text style={styles.destination} numberOfLines={1}>
            {trip.destination}
          </Text>
          <AppleTouchFeedback
            onPress={onDelete}
            style={styles.deleteBtn}
            hapticStyle="impactLight">
            <Icon name="delete" size={22} color={'white'} />
          </AppleTouchFeedback>
        </View>
        <View style={styles.dateRow}>
          <Icon
            name="calendar-today"
            size={14}
            color={theme.colors.foreground2}
          />
          <Text style={styles.dateText}>{dateRange}</Text>
        </View>
        <View style={styles.bottomRow}>
          <View style={styles.weatherBadge}>
            <Icon
              name={WEATHER_ICONS[dominantCondition]}
              size={16}
              color={'white'}
            />
            <Text style={styles.tempText}>
              {minLow}° – {maxHigh}°F
            </Text>
          </View>
          <Text style={styles.capsuleText}>{capsuleStatus}</Text>
        </View>
      </View>
    </AppleTouchFeedback>
  );
};

export default TripCard;
[]

//////////////////

// import React from 'react';
// import {View, Text, StyleSheet} from 'react-native';
// import Icon from 'react-native-vector-icons/MaterialIcons';
// import {useAppTheme} from '../../context/ThemeContext';
// import {tokens} from '../../styles/tokens/tokens';
// import {Trip, WeatherCondition} from '../../types/trips';
// import AppleTouchFeedback from '../AppleTouchFeedback/AppleTouchFeedback';

// const WEATHER_ICONS: Record<WeatherCondition, string> = {
//   sunny: 'wb-sunny',
//   'partly-cloudy': 'wb-cloudy',
//   cloudy: 'cloud',
//   rainy: 'grain',
//   snowy: 'ac-unit',
//   windy: 'air',
// };

// type Props = {
//   trip: Trip;
//   onPress: () => void;
//   onDelete: () => void;
// };

// const TripCard = ({trip, onPress, onDelete}: Props) => {
//   const {theme} = useAppTheme();

//   const weather = trip.weather ?? [];

//   const temps = weather.map(w => ({high: w.highF, low: w.lowF}));
//   const maxHigh =
//     temps.length > 0 ? Math.max(...temps.map(t => t.high)) : 70;
//   const minLow = temps.length > 0 ? Math.min(...temps.map(t => t.low)) : 50;

//   const conditionCounts: Record<string, number> = {};
//   weather.forEach(w => {
//     conditionCounts[w.condition] = (conditionCounts[w.condition] || 0) + 1;
//   });
//   const dominantCondition =
//     (Object.entries(conditionCounts).sort(
//       (a, b) => b[1] - a[1],
//     )[0]?.[0] as WeatherCondition) || 'partly-cloudy';

//   const start = new Date(trip.startDate + 'T00:00:00');
//   const end = new Date(trip.endDate + 'T00:00:00');
//   const formatDate = (d: Date) =>
//     d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
//   const dateRange = `${formatDate(start)} – ${formatDate(end)}`;

//   const numOutfits = trip.capsule?.outfits?.length ?? 0;
//   const backupCount = trip.capsule?.tripBackupKit?.length ?? 0;
//   const numItems =
//     (trip.capsule?.packingList ?? []).reduce((sum, g) => sum + (g.items?.length ?? 0), 0)
//     + backupCount;
//   const capsuleStatus = trip.capsule
//     ? `${numOutfits} looks · ${numItems} items`
//     : 'No capsule yet';

//   const styles = StyleSheet.create({
//     card: {
//       backgroundColor: theme.colors.surface,
//       borderRadius: tokens.borderRadius.xl,
//       padding: tokens.spacing.lg,
//       marginBottom: tokens.spacing.md,
//       borderWidth: tokens.borderWidth.hairline,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     topRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'flex-start',
//     },
//     destination: {
//       fontSize: 20,
//       fontWeight: '700',
//       color: theme.colors.foreground,
//       marginBottom: 4,
//       flex: 1,
//     },
//     deleteBtn: {
//       padding: 4,
//       backgroundColor: 'black',
//       borderRadius: 50,
//       borderWidth: tokens.borderWidth.hairline
//     },
//     dateRow: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 6,
//       marginBottom: 14,
//     },
//     dateText: {
//       fontSize: 14,
//       color: theme.colors.foreground2,
//       fontWeight: '500',
//     },
//     bottomRow: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//     },
//     weatherBadge: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 6,
//       backgroundColor: 'black',
//       paddingHorizontal: 10,
//       paddingVertical: 6,
//       borderRadius: tokens.borderRadius.lg,
//     },
//     tempText: {
//       fontSize: 13,
//       fontWeight: '600',
//       color: 'white',
//     },
//     capsuleText: {
//       fontSize: 13,
//       fontWeight: '500',
//       color: theme.colors.foreground2,
//     },
//   });

//   return (
//     <AppleTouchFeedback onPress={onPress} hapticStyle="impactLight">
//       <View style={styles.card}>
//         <View style={styles.topRow}>
//           <Text style={styles.destination} numberOfLines={1}>
//             {trip.destination}
//           </Text>
//           <AppleTouchFeedback
//             onPress={onDelete}
//             style={styles.deleteBtn}
//             hapticStyle="impactLight">
//             <Icon name="delete" size={22} color={'red'} />
//           </AppleTouchFeedback>
//         </View>
//         <View style={styles.dateRow}>
//           <Icon
//             name="calendar-today"
//             size={14}
//             color={theme.colors.foreground2}
//           />
//           <Text style={styles.dateText}>{dateRange}</Text>
//         </View>
//         <View style={styles.bottomRow}>
//           <View style={styles.weatherBadge}>
//             <Icon
//               name={WEATHER_ICONS[dominantCondition]}
//               size={16}
//               color={'white'}
//             />
//             <Text style={styles.tempText}>
//               {minLow}° – {maxHigh}°F
//             </Text>
//           </View>
//           <Text style={styles.capsuleText}>{capsuleStatus}</Text>
//         </View>
//       </View>
//     </AppleTouchFeedback>
//   );
// };

// export default TripCard;
