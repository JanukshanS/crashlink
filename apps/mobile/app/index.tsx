/** Entry redirect - AuthGate immediately routes by role (§2.2). */
import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/(auth)/welcome" />;
}
