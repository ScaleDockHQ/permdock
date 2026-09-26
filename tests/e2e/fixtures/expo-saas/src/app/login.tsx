import { loginUsers } from '@permdock/e2e-saas-kit/nav';
import { Pressable, Text, View } from 'react-native';

import { post } from '../lib/session';

async function signIn(user: string): Promise<void> {
  await post('/api/login', { user });
  window.location.assign('/');
}

export default function Login() {
  return (
    <View>
      <Text role="heading">Sign in</Text>
      {loginUsers.map((user) => (
        <Pressable key={user} role="button" onPress={() => void signIn(user)}>
          <Text>Sign in as {user}</Text>
        </Pressable>
      ))}
    </View>
  );
}
