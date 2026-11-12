import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1>After School Project</h1>
      <p>学校・在校生・卒業生をつなぐコミュニティ</p>
      <p className={styles.status}>ただいま準備中です。</p>
    </main>
  );
}
