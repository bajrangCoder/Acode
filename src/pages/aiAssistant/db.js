// src/pages/aiAssistant/db.js (or a more general lib folder)

const DB_NAME = "AIAssistant.db"; // SQLite convention for .db extension
const DB_LOCATION = "default"; // Standard location

let db = null;

// Function to open or create the database
function openDB() {
	return new Promise((resolve, reject) => {
		if (db) {
			return resolve(db);
		}
		if (!window.sqlitePlugin) {
			const msg =
				"SQLite plugin is not available. Make sure cordova-sqlite-storage is installed and deviceready has fired.";
			console.error(msg);
			// TODO: Maybe want to queue DB operations or show an error to the user
			return reject(new Error(msg));
		}

		db = window.sqlitePlugin.openDatabase(
			{ name: DB_NAME, location: DB_LOCATION },
			(openedDb) => {
				console.log("SQLite DB opened successfully");
				db = openedDb; // Assign the opened DB instance
				initializeTables()
					.then(() => resolve(db))
					.catch(reject);
			},
			(error) => {
				console.error("Error opening SQLite DB:", JSON.stringify(error));
				reject(error);
			},
		);
	});
}

// Function to initialize tables if they don't exist
function initializeTables() {
	return new Promise((resolve, reject) => {
		if (!db) return reject(new Error("DB not open for table initialization"));
		db.transaction(
			(tx) => {
				tx.executeSql(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    createdAt INTEGER,
                    lastModifiedAt INTEGER,
                    profile TEXT
                )
            `);
				tx.executeSql(`
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversationId TEXT,
                    role TEXT,
                    content TEXT,
                    timestamp INTEGER,
                    FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
                )
            `);
				// Index for faster querying of messages by conversationId and sorting
				tx.executeSql(
					`CREATE INDEX IF NOT EXISTS idx_messages_conversationId_timestamp ON messages (conversationId, timestamp)`,
				);
				tx.executeSql(
					`CREATE INDEX IF NOT EXISTS idx_conversations_lastModifiedAt ON conversations (lastModifiedAt)`,
				);
			},
			(error) => {
				console.error(
					"Transaction error during table initialization:",
					JSON.stringify(error),
				);
				reject(error);
			},
			() => {
				console.log("Tables initialized (or already exist).");
				resolve();
			},
		);
	});
}

// --- Helper for executing SQL ---
function executeSqlAsync(transaction, sql, params = []) {
	return new Promise((resolve, reject) => {
		transaction.executeSql(
			sql,
			params,
			(tx, resultSet) => resolve(resultSet),
			(tx, error) => {
				console.error(
					"SQL Error:",
					error.message,
					"Query:",
					sql,
					"Params:",
					params,
				);
				reject(error);
			},
		);
	});
}

// --- Conversation Functions ---
export async function addConversation(conversation) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.transaction(async (tx) => {
			try {
				await executeSqlAsync(
					tx,
					"INSERT INTO conversations (id, title, createdAt, lastModifiedAt, profile) VALUES (?, ?, ?, ?, ?)",
					[
						conversation.id,
						conversation.title,
						conversation.createdAt,
						conversation.lastModifiedAt,
						conversation.profile,
					],
				);
				resolve(conversation.id);
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function getConversation(id) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.readTransaction(async (tx) => {
			// Use readTransaction for reads
			try {
				const resultSet = await executeSqlAsync(
					tx,
					"SELECT * FROM conversations WHERE id = ?",
					[id],
				);
				if (resultSet.rows.length > 0) {
					resolve(resultSet.rows.item(0));
				} else {
					resolve(null); // Or undefined, consistent with IndexedDB version
				}
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function getAllConversations() {
	await openDB();
	return new Promise((resolve, reject) => {
		db.readTransaction(async (tx) => {
			try {
				const resultSet = await executeSqlAsync(
					tx,
					"SELECT * FROM conversations ORDER BY lastModifiedAt DESC",
				);
				const conversations = [];
				for (let i = 0; i < resultSet.rows.length; i++) {
					conversations.push(resultSet.rows.item(i));
				}
				resolve(conversations);
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function updateConversation(conversation) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.transaction(async (tx) => {
			try {
				await executeSqlAsync(
					tx,
					"UPDATE conversations SET title = ?, lastModifiedAt = ?, profile = ? WHERE id = ?",
					[
						conversation.title,
						conversation.lastModifiedAt,
						conversation.profile,
						conversation.id,
					],
				);
				resolve(conversation.id);
			} catch (error) {
				reject(error);
			}
		});
	});
}

// --- Message Functions ---
export async function addMessageToDB(message) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.transaction(async (tx) => {
			try {
				await executeSqlAsync(
					tx,
					"INSERT INTO messages (id, conversationId, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
					[
						message.id,
						message.conversationId,
						message.role,
						message.content,
						message.timestamp,
					],
				);
				resolve(message.id);
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function getMessagesForConversation(conversationId) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.readTransaction(async (tx) => {
			try {
				const resultSet = await executeSqlAsync(
					tx,
					"SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC",
					[conversationId],
				);
				const messages = [];
				for (let i = 0; i < resultSet.rows.length; i++) {
					messages.push(resultSet.rows.item(i));
				}
				resolve(messages);
			} catch (error) {
				reject(error);
			}
		});
	});
}

// --- Deletion functions (example) ---
export async function deleteConversation(conversationId) {
	await openDB();
	return new Promise((resolve, reject) => {
		db.transaction(async (tx) => {
			try {
				// CASCADE DELETE on messages table should handle associated messages
				await executeSqlAsync(tx, "DELETE FROM conversations WHERE id = ?", [
					conversationId,
				]);
				console.log(`Conversation ${conversationId} and its messages deleted.`);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
}

// Ensure DB is opened and tables initialized when module loads or on first call
