-- Q&Aのカテゴリー4件（DB・ER設計書 §4、API設計書 §7）。カテゴリーAPI（API-QA-01）が返す値と一致させる。
-- 既に同じコードの行がある環境（開発seedで投入済みのDBなど）では、その行のID・名称を変えない。
INSERT INTO "qa_categories" ("code", "name") VALUES
  ('career', '就職・キャリア'),
  ('learning', '技術・学習'),
  ('projects', '制作・プロジェクト'),
  ('chat', '雑談')
ON CONFLICT ("code") DO NOTHING;
