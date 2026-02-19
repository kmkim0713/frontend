export interface User {
  userId: string;
  userName: string;
}

interface UserCredentials extends User {
  password: string;
}

const USERS: Map<string, UserCredentials> = new Map([
  ['aa', { userId: 'aa', password: 'aa', userName: 'testUser01' }],
  ['bb', { userId: 'bb', password: 'bb', userName: 'testUser02' }],
  ['cc', { userId: 'cc', password: 'cc', userName: 'testUser03' }],
]);

export function findUser(userId: string, password: string): User | null {
  const user = USERS.get(userId);
  if (user && user.password === password) {
    return { userId: user.userId, userName: user.userName };
  }
  return null;
}
