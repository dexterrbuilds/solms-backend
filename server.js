const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID, getMint } = require('@solana/spl-token');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Establish Solana connection to Mainnet
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Helper function to validate and create PublicKey
function safePublicKey(key) {
  try {
    return new PublicKey(key);
  } catch (err) {
    console.error('Invalid public key:', key);
    throw new Error('Invalid public key');
  }
}

// Route for processing transactions
app.post('/send', async (req, res) => {
  try {
    const { recipients, token, publicKey } = req.body;

    console.log('Received public key:', publicKey);

    // Validate publicKey from frontend
    if (!publicKey) {
      return res.status(400).send('Public key is required.');
    }
    
    let senderPublicKey;
    try {
      senderPublicKey = safePublicKey(publicKey);
    } catch (err) {
      return res.status(400).send('Invalid public key from sender.');
    }

    // Create a new transaction
    const transaction = new Transaction();

    // Iterate over recipients and add instructions based on token type
    for (const recipient of recipients) {
      if (!recipient.address || recipient.amount === undefined) {
        return res.status(400).send('Recipient address and amount are required');
      }

      const recipientPubkey = safePublicKey(recipient.address);
      let amountUnits;

      if (token === 'SOL') {
        // Send SOL
        amountUnits = recipient.amount * LAMPORTS_PER_SOL;

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderPublicKey,
            toPubkey: recipientPubkey,
            lamports: amountUnits,
          })
        );
      } else {
        // Send SPL Token
        const mintPublicKey = safePublicKey(token); // SPL Token mint address
        const mintInfo = await connection.getParsedAccountInfo(mintPublicKey);

        if (!mintInfo.value) {
          throw new Error('Invalid SPL token mint address.');
        }

        const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
          connection,
          senderPublicKey,
          mintPublicKey,
          senderPublicKey
        );

        const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
          connection,
          senderPublicKey,
          mintPublicKey,
          recipientPubkey
        );

        // Fetch token mint info to get decimals
        const mintData = await getMint(connection, mintPublicKey);
        const decimals = mintData.decimals;

        amountUnits = recipient.amount * 10 ** decimals; // Use correct decimal places for SPL tokens

        transaction.add(
          createTransferInstruction(
            senderTokenAccount.address,
            recipientTokenAccount.address,
            senderPublicKey,
            amountUnits,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }
    }

    // Set a fixed fee (e.g., 0.0005 SOL)
    const fee = 0.0005 * LAMPORTS_PER_SOL;
    transaction.feePayer = senderPublicKey;

    // Fetch recent blockhash and assign to transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Serialize transaction and send response
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false }).toString('base64');
    res.send(serializedTransaction);
  } catch (error) {
    console.error('Error processing transaction:', error);
    res.status(500).send(error.message);
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
