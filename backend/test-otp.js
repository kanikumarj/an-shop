const axios = require('axios');
const FormData = require('form-data');

async function test() {
  const token = 'be68c87331ffe75b3636420f61aa8e6d';
  const tonumber = '+918122206326';
  const otp = '247942';

  const form = new FormData();
  form.append('token', token);
  form.append('tonumber', tonumber);
  form.append('otp', otp);

  try {
    console.log('Sending test OTP via DBuddyZ...');
    const response = await axios.post('https://dbuddyz.prismswift.com/send/', form, {
      headers: form.getHeaders()
    });
    console.log('SUCCESS RESPONSE:', response.data);
  } catch (error) {
    console.error('ERROR:', error.message);
    if (error.response) {
      console.error('ERROR RESPONSE DATA:', error.response.data);
    }
  }
}

test();
