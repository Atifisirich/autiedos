import { seedDemo } from './demo';
import { closePool } from '../db';

seedDemo({ log: (m) => console.log(m) })
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
