import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }) });

/**
 * Push registration STUB. It asks for permission and gets the Expo push token, then stops: there is no ERP table or function that
 * stores a family device token yet (the staff app's `/devices` lives in the OS API). When the platform adds one, call it here with
 * the token. Needs an EAS project id in app.json and FCM / APNs credentials. Returns the token (or null) so a screen can show state.
 */
export async function registerPushStub(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
