import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { post } from './api';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }) });

/** Registers this device for push. Needs an EAS project id and Firebase/APNs credentials (see docs/BUILD-LOG.md). */
export async function registerPush(): Promise<void> {
  if (!Device.isDevice) return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return; // no Expo project configured yet
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'AutoEd OS', importance: Notifications.AndroidImportance.HIGH });
  const t = await Notifications.getExpoPushTokenAsync({ projectId });
  await post('/devices', { token: t.data, platform: Platform.OS === 'ios' ? 'ios' : 'android', device_name: Device.deviceName ?? undefined }).catch(() => undefined);
}
