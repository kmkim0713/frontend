import { useState, FC } from 'react';
import { findUser } from '../constants/users';
import type { User } from '../types';

interface LoginPageProps {
  onLogin: (user: User) => void;
}

const LoginPage: FC<LoginPageProps> = ({ onLogin }) => {
  const [inputId, setInputId] = useState<string>('');
  const [inputPassword, setInputPassword] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleLogin = (): void => {
    setError('');

    if (!inputId.trim() || !inputPassword.trim()) {
      setError('ID와 비밀번호를 모두 입력해주세요.');
      return;
    }

    const user = findUser(inputId, inputPassword);
    if (!user) {
      setError('ID 또는 비밀번호가 올바르지 않습니다.');
      return;
    }

    onLogin(user);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>MatchNow Meeting Login</h1>
        <p style={styles.subtitle}>Login then join the meeting.</p>

        <div style={styles.formGroup}>
          <label style={styles.label}>ID *</label>
          <input
            type="text"
            value={inputId}
            onChange={(e) => setInputId(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="ID 입력"
            style={styles.input}
          />
        </div>

        <div style={styles.formGroup}>
          <label style={styles.label}>Password *</label>
          <input
            type="password"
            value={inputPassword}
            onChange={(e) => setInputPassword(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="비밀번호 입력"
            style={styles.input}
          />
        </div>

        {error && <div style={styles.errorMessage}>{error}</div>}

        <button onClick={handleLogin} style={styles.loginButton}>
          LOGIN
        </button>

        <div style={styles.testCredentials}>
          <p style={styles.testCredentialsTitle}>테스트 계정</p>
          <p style={styles.testCredentialsText}>ID: aa / Password: aa</p>
          <p style={styles.testCredentialsText}>ID: bb / Password: bb</p>
          <p style={styles.testCredentialsText}>ID: cc / Password: cc</p>
        </div>
      </div>
    </div>
  );
};

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--bg-primary)',
    padding: '16px',
  } as React.CSSProperties,
  card: {
    background: 'var(--bg-surface)',
    borderRadius: '12px',
    padding: '48px',
    width: '100%',
    maxWidth: '500px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
  } as React.CSSProperties,
  title: {
    fontSize: '28px',
    fontWeight: '700',
    color: 'var(--text-primary)',
    marginBottom: '8px',
    letterSpacing: '-0.5px',
  } as React.CSSProperties,
  subtitle: {
    fontSize: '14px',
    color: 'var(--text-muted)',
    marginBottom: '24px',
  } as React.CSSProperties,
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '16px',
  } as React.CSSProperties,
  label: {
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-primary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  input: {
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-input)',
    borderRadius: '6px',
    padding: '12px 14px',
    fontSize: '14px',
    outline: 'none',
    transition: 'border-color 0.2s ease',
  } as React.CSSProperties,
  loginButton: {
    width: '100%',
    background: 'var(--btn-primary)',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    padding: '14px 16px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '24px',
    transition: 'background 0.2s ease',
  } as React.CSSProperties,
  errorMessage: {
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid #ef4444',
    borderRadius: '6px',
    color: '#ef4444',
    padding: '12px',
    fontSize: '13px',
    marginBottom: '16px',
  } as React.CSSProperties,
  testCredentials: {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '12px',
  } as React.CSSProperties,
  testCredentialsTitle: {
    color: 'var(--text-primary)',
    fontWeight: '600',
    marginBottom: '8px',
  } as React.CSSProperties,
  testCredentialsText: {
    color: 'var(--text-muted)',
    margin: '4px 0',
  } as React.CSSProperties,
};

export default LoginPage;
