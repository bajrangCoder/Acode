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
        // LangGraph Checkpoints Table
        tx.executeSql(`
                CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_id TEXT NOT NULL,
                    parent_checkpoint_id TEXT,
                    checkpoint TEXT,
                    updated_at INTEGER,
                    PRIMARY KEY (thread_id, checkpoint_id)
                )
            `);
				// Indexes
				tx.executeSql(
					`CREATE INDEX IF NOT EXISTS idx_messages_conversationId_timestamp ON messages (conversationId, timestamp)`,
				);
				tx.executeSql(
					`CREATE INDEX IF NOT EXISTS idx_conversations_lastModifiedAt ON conversations (lastModifiedAt)`,
				);
				tx.executeSql(
              `CREATE INDEX IF NOT EXISTS idx_lg_checkpoints_thread_id_updated_at ON langgraph_checkpoints (thread_id, updated_at DESC)`);
				
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

// --- LangGraph Checkpoint DB Functions ---
export async function getLangGraphCheckpointFromDB(threadId, checkpointId = null) {
    await openDB();
    return new Promise((resolve, reject) => {
        db.readTransaction(async (tx) => {
            try {
                let sql = "SELECT checkpoint FROM langgraph_checkpoints WHERE thread_id = ?";
                const params = [threadId];
                if (checkpointId) {
                    sql += " AND checkpoint_id = ?";
                    params.push(checkpointId);
                } else {
                    sql += " ORDER BY updated_at DESC LIMIT 1"; // Get latest for the thread
                }
                const resultSet = await executeSqlAsync(tx, sql, params);
                if (resultSet.rows.length > 0) {
                    const checkpointStr = resultSet.rows.item(0).checkpoint;
                    resolve(checkpointStr ? JSON.parse(checkpointStr) : null);
                } else {
                    resolve(null);
                }
            } catch (error) {
                console.error(`[DB] Error getting LangGraph checkpoint (thread: ${threadId}, ckpt: ${checkpointId}):`, error);
                reject(error);
            }
        });
    });
}

export async function putLangGraphCheckpointInDB(threadId, checkpointTuple) {
    await openDB();
    const checkpointId = checkpointTuple?.config?.configurable?.checkpoint_id;
    const parentCheckpointId = checkpointTuple?.parent_config?.configurable?.checkpoint_id || null;

    if (!checkpointId) {
        console.error("[DB] Cannot save LangGraph checkpoint: checkpoint_id missing from checkpointTuple.config");
        return Promise.reject(new Error("Missing checkpoint_id in checkpoint config"));
    }
    const checkpointStr = JSON.stringify(checkpointTuple);
    const updatedAt = Date.parse(checkpointTuple.config?.configurable?.checkpoint_id?.split("T")[0] || checkpointTuple.ts || new Date().toISOString());


    return new Promise((resolve, reject) => {
        db.transaction(async (tx) => {
            try {
                await executeSqlAsync(tx,
                    "INSERT OR REPLACE INTO langgraph_checkpoints (thread_id, checkpoint_id, parent_checkpoint_id, checkpoint, updated_at) VALUES (?, ?, ?, ?, ?)",
                    [threadId, checkpointId, parentCheckpointId, checkpointStr, updatedAt]
                );
                resolve();
            } catch (error) {
                console.error(`[DB] Error putting LangGraph checkpoint (thread: ${threadId}, ckpt: ${checkpointId}):`, error);
                reject(error);
            }
        });
    });
}

export async function listLangGraphCheckpointsFromDB(threadId, limit, beforeConfig = null) {
    await openDB();
    return new Promise((resolve, reject) => {
        db.readTransaction(async (tx) => {
            try {
                let sql = "SELECT checkpoint FROM langgraph_checkpoints WHERE thread_id = ?";
                const params = [threadId];
                let beforeTimestamp = null;

                if (beforeConfig?.configurable?.checkpoint_id) {
                    // Attempt to get the timestamp of the 'before' checkpoint to filter accurately
                    const beforeCheckpointTuple = await getLangGraphCheckpointFromDB(threadId, beforeConfig.configurable.checkpoint_id);
                    if (beforeCheckpointTuple) {
                        beforeTimestamp = Date.parse(beforeCheckpointTuple.ts || beforeCheckpointTuple.config?.configurable?.checkpoint_id?.split("T")[0] || new Date(0).toISOString());
                        if (beforeTimestamp) {
                            sql += " AND updated_at < ?";
                            params.push(beforeTimestamp);
                        } else {
                             console.warn("[DB] list: Could not determine timestamp for 'before' checkpoint_id:", beforeConfig.configurable.checkpoint_id);
                        }
                    } else {
                        console.warn("[DB] list: 'before' checkpoint_id not found:", beforeConfig.configurable.checkpoint_id);
                    }
                }

                sql += " ORDER BY updated_at DESC";
                if (limit) {
                    sql += " LIMIT ?";
                    params.push(limit);
                }

                const resultSet = await executeSqlAsync(tx, sql, params);
                const checkpoints = [];
                for (let i = 0; i < resultSet.rows.length; i++) {
                    const checkpointStr = resultSet.rows.item(i).checkpoint;
                    if (checkpointStr) {
                        checkpoints.push(JSON.parse(checkpointStr));
                    }
                }
                resolve(checkpoints);
            } catch (error) {
                console.error(`[DB] Error listing LangGraph checkpoints (thread: ${threadId}):`, error);
                reject(error);
            }
        });
    });
}