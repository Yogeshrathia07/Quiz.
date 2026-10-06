import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ClipboardList, House, KeyRound, LogOut, Menu, UserCheck, Users, X } from 'lucide-react';
import { BRAND } from '../brand.js';

const initials = (name) => String(name || '?')
  .replace(/^Guest:\s*/, '')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0].toUpperCase())
  .join('') || '?';

/** Which link the current page belongs to. */
function activeLink(route, isAdmin) {
  if (route.admin === 'attendance') return 'attendance';
  if (route.admin === 'users') return 'users';
  // A student's results are their Home; a teacher's own attempts sit in the account menu.
  if (route.page === 'results') return isAdmin ? null : 'home';
  // One handed-in test: a teacher reaches it from Tests (Taken by me), a student from Home.
  if (route.result) return isAdmin ? 'tests' : 'home';
  if (route.test || route.attend) return null;
  // The quiz list, and a test's dashboard, creator or editor: all the Tests section.
  if (route.admin && route.admin !== 'portal') return 'tests';
  return 'home';
}

/** Closes a popup on Escape and on a tap outside `ref`. */
function useDismiss(open, close, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    const onPointer = (event) => { if (!ref.current?.contains(event.target)) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, close, ref]);
}

/**
 * The bar across the top of every page but a test in progress. On a laptop:
 * the brand, the links, and one account button whose menu holds the rest.
 * On a phone: the brand and a menu button; everything else opens in a panel,
 * so nothing is squeezed onto one line.
 */
export function SiteHeader({ auth, route, go, onChangePassword, onSignOut }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const headerRef = useRef(null);
  const accountRef = useRef(null);
  const user = auth?.user || null;
  const isAdmin = user?.role === 'admin' && !user.isGuest;

  // Faculty do everything with a test - marking and its results too - under
  // Tests; a student's Home is their results.
  const links = [
    { id: 'home', url: '/', label: 'Home', icon: House },
    isAdmin && { id: 'tests', url: '/?admin=tests', label: 'Tests', icon: ClipboardList },
    isAdmin && { id: 'attendance', url: '/?admin=attendance', label: 'Attendance', icon: UserCheck },
    user?.canManageUsers && { id: 'users', url: '/?admin=users', label: 'Users', icon: Users }
  ].filter(Boolean);
  const active = activeLink(route, isAdmin);
  // A guest's password is not theirs to change, and a test page keeps the student on the test.
  const canChangePassword = user && !user.isGuest && !route.test;

  // Moving to another page closes whatever was open.
  useEffect(() => { setMenuOpen(false); setAccountOpen(false); }, [route]);
  useDismiss(menuOpen, () => setMenuOpen(false), headerRef);
  useDismiss(accountOpen, () => setAccountOpen(false), accountRef);

  const open = (url) => (event) => { event.preventDefault(); go(url); };
  const run = (action) => () => { setMenuOpen(false); setAccountOpen(false); action(); };
  const subtitle = user?.isGuest ? 'Guest account' : user?.email;

  return (
    <header className={`site-header nav-bar${menuOpen ? ' is-menu-open' : ''}`} ref={headerRef}>
      <a className="nav-brand" href="/" onClick={open('/')} aria-label={`${BRAND.name} home`}>
        <img className="nav-brand-logo" src="/logo.svg" alt="" width="30" height="30"/>
        <span className="nav-brand-name">{BRAND.wordmark}<span className="nav-brand-dot">.</span></span>
        {BRAND.org && <span className="nav-brand-org">{BRAND.org}</span>}
      </a>

      {user && (
        <nav className="nav-links" aria-label="Primary navigation">
          {links.map((link) => (
            <a key={link.id} href={link.url} onClick={open(link.url)} className={active === link.id ? 'is-active' : undefined}
              aria-current={active === link.id ? 'page' : undefined}><link.icon size={16} strokeWidth={2.2} aria-hidden="true"/>{link.label}</a>
          ))}
        </nav>
      )}

      {user && (
        <div className="nav-account" ref={accountRef}>
          <button className="nav-account-button" type="button" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((value) => !value)}
            aria-label={`${user.name.replace(/^Guest:\s*/, '')}, account menu`}>
            <span className="nav-avatar" aria-hidden="true">{initials(user.name)}</span>
            <span className="nav-account-name">{user.name.replace(/^Guest:\s*/, '')}</span>
            <ChevronDown className="nav-caret" size={15} strokeWidth={2.5} aria-hidden="true"/>
          </button>
          {accountOpen && (
            <div className="nav-dropdown" role="menu">
              <div className="nav-dropdown-who">
                <strong>{user.name.replace(/^Guest:\s*/, '')}</strong>
                <span>{subtitle}</span>
              </div>
              {canChangePassword && <button type="button" role="menuitem" onClick={run(onChangePassword)}><KeyRound size={16} aria-hidden="true"/>Change password</button>}
              <button type="button" role="menuitem" className="is-danger" onClick={run(onSignOut)}><LogOut size={16} aria-hidden="true"/>Sign out</button>
            </div>
          )}
        </div>
      )}

      {user && (
        <button className="nav-menu-button" type="button" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}>
          {menuOpen ? <X size={22} aria-hidden="true"/> : <Menu size={22} aria-hidden="true"/>}
        </button>
      )}

      {user && menuOpen && <div className="nav-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)}/>}
      {user && menuOpen && (
        <div className="nav-panel">
          <nav aria-label="Menu">
            {links.map((link) => (
              <a key={link.id} href={link.url} onClick={open(link.url)} className={active === link.id ? 'is-active' : undefined}
                aria-current={active === link.id ? 'page' : undefined}><link.icon size={19} strokeWidth={2.1} aria-hidden="true"/>{link.label}</a>
            ))}
          </nav>
          <div className="nav-panel-account">
            <span className="nav-avatar" aria-hidden="true">{initials(user.name)}</span>
            <div>
              <strong>{user.name.replace(/^Guest:\s*/, '')}</strong>
              <span>{subtitle}</span>
            </div>
          </div>
          <div className="nav-panel-actions">
            {canChangePassword && <button className="button button-secondary" type="button" onClick={run(onChangePassword)}>Change password</button>}
            <button className="button button-danger" type="button" onClick={run(onSignOut)}>Sign out</button>
          </div>
        </div>
      )}
    </header>
  );
}
