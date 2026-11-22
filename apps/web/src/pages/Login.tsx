import { useState, type FormEvent } from 'react';
import { USER_COLORS } from '@ensemble/shared';
import { Avatar } from '../messenger/Avatar';
import { navigate } from '../router';
import { useSession } from '../store/session';
import { btn, cvar } from '../ui/tg';

const QUICK = [
  { name: 'Alice', label: 'Alice 로 입장', color: USER_COLORS.coral },
  { name: 'Bob', label: 'Bob 으로 입장', color: USER_COLORS.sky },
];

export function Login() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useSession((s) => s.error);

  async function go(n: string) {
    setBusy(true);
    const ok = await useSession.getState().login(n);
    setBusy(false);
    if (ok) navigate('/', true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void go(name);
  }

  return (
    <main className="tg-scene-bit flex h-full items-center justify-center p-4">
      <div className="tg-panel tg-login">
        <div>
          <div className="tg-mono">ENSEMBLE ROOM</div>
          <h1 className="tg-title mt-1.5 text-display">누구로 들어갈까요?</h1>
          <p className="tg-aux mt-1.5">이름을 골라 입장하세요. 두 탭에서 서로 다른 사용자로 로그인할 수 있어요.</p>
        </div>

        {QUICK.map((q) => (
          <button
            key={q.name}
            type="button"
            disabled={busy}
            onClick={() => void go(q.name)}
            className={btn('person', { block: true })}
            style={cvar(q.color)}
          >
            <Avatar name={q.name} color={q.color} size={24} />
            {q.label}
          </button>
        ))}

        <form onSubmit={onSubmit} className="tg-input">
          <label htmlFor="login-name" className="sr-only">
            사용자 이름
          </label>
          {name.trim() && <Avatar name={name.trim()} color={USER_COLORS.coral} size={28} />}
          <input
            id="login-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="직접 입력"
            autoComplete="off"
            className="tg-input-el min-w-0 flex-1"
          />
          <button type="submit" disabled={busy || !name.trim()} className={btn('primary')}>
            입장
          </button>
        </form>

        {error && (
          <p role="alert" className="text-aux text-danger">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
