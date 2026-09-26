import { ClipboardList, QrCode } from 'lucide-react';
import { AuthForm } from '../components/AuthForm.jsx';
import { BRAND } from '../brand.js';
import { MyResultsScreen } from './student/MyResultsScreen.jsx';

const AUTH_MESSAGES = {
  'not-allowed': 'Only college Microsoft accounts can sign in here. Log in with your college email and password instead.',
  blocked: 'This account has been blocked by the administrator.',
  invalid: 'That sign-in link had expired. Please try again.',
  'microsoft-off': 'Microsoft sign-in is not configured on this server. Log in with your email and password.',
  failed: 'Microsoft sign-in could not be completed. Please try again.'
};

export function HomeScreen({ auth, onSignedIn, go, showToast }) {
  const issue = new URLSearchParams(window.location.search).get('auth');

  if (!auth.user) {
    return (
      <section className="sign-in-page">
        <div className="sign-in-intro">
          <h1 className="sign-in-tagline">{BRAND.tagline}</h1>
          <ul className="sign-in-who">
            <li><QrCode size={18} aria-hidden="true"/><span><strong>Students</strong> scan the QR your teacher shows in class, then sign in with your college email.</span></li>
            <li><ClipboardList size={18} aria-hidden="true"/><span><strong>Faculty</strong> sign in to set tests and take attendance.</span></li>
          </ul>
        </div>
        <div className="sign-in-panel">
          {issue && <div className="notice danger">{AUTH_MESSAGES[issue] || AUTH_MESSAGES.failed}</div>}
          {!issue && auth.signedOutElsewhere && (
            <div className="notice danger">You were signed out because your account signed in on another device. Only one login at a time is allowed.</div>
          )}
          <div className="card sign-in-card">
            <AuthForm microsoft={auth.microsoft} onSignedIn={onSignedIn} showToast={showToast}/>
          </div>
        </div>
      </section>
    );
  }

  // Guests exist for one test only; they have no history to show.
  if (auth.user.isGuest) {
    return (
      <section className="card guest-home">
        <h1>You're signed in as a guest</h1>
        <p>A guest account is for one test. Open that test's link, or scan its QR again, to carry on.</p>
        <p className="help">Signing out submits your test as it stands.</p>
      </section>
    );
  }

  return <MyResultsScreen go={go} showToast={showToast} isStudent={auth.user.role === 'student'}/>;
}
