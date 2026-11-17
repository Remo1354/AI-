-- 对话消息可以附带图片（例如把自己的画作发给助手点评）。
-- attachments 是 JSON 数组，元素是 documents 表里图片的 id。
ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
