// 첫 운영자 계정 만들기 (그 뒤로는 admin.html에서 만든다).
// 실행: node account.js <ID> <비밀번호> [admin|school] [학교코드]
//   예: node account.js admin 비밀번호123 admin
//   → 출력된 명령을 그대로 실행하면 된다.
import { hashPassword } from './src/auth.js';

const [id, pw, role = 'admin', school] = process.argv.slice(2);
if (!id || !pw) { console.error('사용법: node account.js <ID> <비밀번호> [admin|school] [학교코드]'); process.exit(1); }
const hash = await hashPassword(pw);
const sql = `insert into accounts (login_id, password_hash, school_code, role) values ('${id}', '${hash}', ${school ? `'${school}'` : 'null'}, '${role}')
  on conflict (login_id) do update set password_hash = excluded.password_hash, school_code = excluded.school_code, role = excluded.role;`;
console.log(`wrangler d1 execute mock-exam --remote --command "${sql.replace(/\n\s*/g, ' ')}"`);
