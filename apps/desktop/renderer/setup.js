const form = document.querySelector('#connect-form');
const address = document.querySelector('#server-url');
const errorBox = document.querySelector('#error');
const button = document.querySelector('#connect-button');

window.connectTogetherDesktop.getServer().then((saved) => { if (saved) address.value = saved; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.firstChild.textContent = 'Verbinde … ';
  try {
    await window.connectTogetherDesktop.connect(address.value);
  } catch (error) {
    errorBox.textContent = error.message || 'Der Server konnte nicht geöffnet werden.';
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.firstChild.textContent = 'Server öffnen ';
  }
});
