const express = require('express');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, TOKEN_PROGRAM_ID, getMint } = require('@solana/spl-token');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Middleware
app.use(cors()); // Enable CORS to avoid policy issues
app.use(bodyParser.json()); // Parse incoming JSON requests

// Solana connection to mainnet
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Endpoint to fetch wallet balance
app.post('/balance', async (req, res) => {
    try {
        const { publicKey } = req.body;
        if (!publicKey) {
            return res.status(400).json({ error: 'Missing publicKey' });
        }

        const walletPublicKey = new PublicKey(publicKey);
        const balanceInLamports = await connection.getBalance(walletPublicKey);
        const balanceInSol = balanceInLamports / LAMPORTS_PER_SOL; // Convert Lamports to SOL

        res.status(200).json({
            balance: balanceInSol,
        });
    } catch (error) {
        console.error('Error fetching balance:', error);
        res.status(500).json({
            error: 'Failed to fetch balance.',
        });
    }
});

// Endpoint to fetch SPL tokens held by the wallet
app.post('/tokens', async (req, res) => {
    try {
        const { publicKey } = req.body;
        if (!publicKey) {
            return res.status(400).json({ error: 'Missing publicKey' });
        }

        const walletPublicKey = new PublicKey(publicKey);

        // Fetch all token accounts owned by the wallet
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, { programId: TOKEN_PROGRAM_ID });

        // Format the response to only include relevant token info
        const tokens = tokenAccounts.value.map(accountInfo => {
            const tokenAmount = accountInfo.account.data.parsed.info.tokenAmount.uiAmount;
            const mintAddress = accountInfo.account.data.parsed.info.mint;

            return {
                mint: mintAddress,
                amount: tokenAmount
            };
        });

        res.status(200).json({
            tokens,
        });
    } catch (error) {
        console.error('Error fetching tokens:', error);
        res.status(500).json({
            error: 'Failed to fetch tokens.',
        });
    }
});

// Endpoint to handle transaction preparation
app.post('/send', async (req, res) => {
    try {
        // Log the received payload
        console.log('Received payload:', req.body);

        const { recipients, publicKey, token } = req.body;

        if (!publicKey || !recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const walletPublicKey = new PublicKey(publicKey);
        const transaction = new Transaction();

        // Fetch recent blockhash
        const { blockhash } = await connection.getRecentBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletPublicKey;

        for (const recipient of recipients) {
            const recipientPubKey = new PublicKey(recipient.address);
            let amount = recipient.amount;

            if (token === 'SOL') {
                // Create a SOL transfer instruction
                const instruction = SystemProgram.transfer({
                    fromPubkey: walletPublicKey,
                    toPubkey: recipientPubKey,
                    lamports: amount * LAMPORTS_PER_SOL, // Convert SOL to lamports
                });
                transaction.add(instruction);
            } else {
                // For SPL token transfer
                const tokenMintAddress = new PublicKey(token);

                // Fetch the mint info to get decimals
                const mintInfo = await getMint(connection, tokenMintAddress);
                const decimals = mintInfo.decimals;

                // Adjust the amount based on the token decimals
                const adjustedAmount = amount * Math.pow(10, decimals);

                // Fetch the associated token account for the recipient
                const recipientTokenAddress = await getAssociatedTokenAddress(
                    tokenMintAddress,       // Token mint address
                    recipientPubKey,        // Recipient's public key
                    false,                  // Allow owner to be the owner of the associated token account
                    TOKEN_PROGRAM_ID,       // Token program ID
                );

                // Log the recipient token address
                console.log('Recipient Token Address:', recipientTokenAddress.toBase58());

                // Fetch the associated token account for the sender
                const senderTokenAddress = await getAssociatedTokenAddress(
                    tokenMintAddress,       // Token mint address
                    walletPublicKey,        // Sender's public key
                    false,                  // Allow owner to be the owner of the associated token account
                    TOKEN_PROGRAM_ID,       // Token program ID
                );

                // Log the sender token address
                console.log('Sender Token Address:', senderTokenAddress.toBase58());

                // Check if the recipient's token account exists
                let recipientTokenAccountInfo = await connection.getAccountInfo(recipientTokenAddress);
                if (!recipientTokenAccountInfo) {
                    // Create the associated token account for the recipient if it doesn't exist
                    const createRecipientTokenAccountIx = createAssociatedTokenAccountInstruction(
                        walletPublicKey,        // Payer of the transaction
                        recipientTokenAddress,  // The associated token account
                        recipientPubKey,        // Recipient's public key
                        tokenMintAddress        // The SPL Token mint address
                    );
                    transaction.add(createRecipientTokenAccountIx);
                    console.log('Created associated token account for recipient.');
                }

                // Check if the sender's token account exists
                let senderTokenAccountInfo = await connection.getAccountInfo(senderTokenAddress);
                if (!senderTokenAccountInfo) {
                    // Create the associated token account for the sender if it doesn't exist
                    const createSenderTokenAccountIx = createAssociatedTokenAccountInstruction(
                        walletPublicKey,        // Payer of the transaction
                        senderTokenAddress,     // The associated token account
                        walletPublicKey,        // Sender's public key
                        tokenMintAddress        // The SPL Token mint address
                    );
                    transaction.add(createSenderTokenAccountIx);
                    console.log('Created associated token account for sender.');
                }

                // Now add the transfer instruction
                const tokenTransferInstruction = createTransferInstruction(
                    senderTokenAddress,       // Sender's token account
                    recipientTokenAddress,    // Recipient's token account
                    walletPublicKey,          // Owner of the source account
                    adjustedAmount            // Amount (in smallest units)
                );
                transaction.add(tokenTransferInstruction);
            }
        }

        // Serialize and send the transaction back to the frontend
        const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
        });

        res.status(200).json({
            success: true,
            transaction: serializedTransaction.toString('base64'),
        });
    } catch (error) {
        console.error('Error creating transaction:', error);
        res.status(500).json({
            error: 'Failed to create transaction.',
        });
    }
});

// Endpoint to submit signed transaction
app.post('/submit', async (req, res) => {
    try {
        const { signedTransaction } = req.body;
        if (!signedTransaction) {
            return res.status(400).json({ error: 'Missing signedTransaction' });
        }

        const transactionBuffer = Buffer.from(signedTransaction, 'base64');
        const transaction = Transaction.from(transactionBuffer);

        // Submit the signed transaction to the Solana network
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(signature, 'confirmed');

        res.status(200).json({
            success: true,
            signature,
        });
    } catch (error) {
        console.error('Error submitting transaction:', error);
        res.status(500).json({
            error: 'Failed to submit transaction.',
        });
    }
});

// Start server
app.listen(3000, () => {
    console.log('Backend server is running on port 3000');
});
