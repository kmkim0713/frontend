import { useState, FC } from 'react';
import LoginPage from './components/LoginPage';
import MeetingPage from './components/MeetingPage';
import type { User } from './types';

const App: FC = () => {
  const [loggedInUser, setLoggedInUser] = useState<User | null>(null);

  if (!loggedInUser) {
    return <LoginPage onLogin={setLoggedInUser} />;
  }

  return (
    <MeetingPage
      user={loggedInUser}
      onLeaveApp={() => setLoggedInUser(null)}
    />
  );
};

export default App;
