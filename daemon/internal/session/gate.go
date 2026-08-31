package session

import "sync"

// fifo 按等待者入队顺序传递锁（协议 §3.4：同 session FIFO）。
// sync.Mutex 不保证唤醒顺序，不能用来满足「响应完成顺序不能反转 currentTarget」。
type fifo struct {
	mu   sync.Mutex
	held bool
	wait []chan struct{}
}

func (f *fifo) Lock() {
	f.mu.Lock()
	if !f.held {
		f.held = true
		f.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	f.wait = append(f.wait, ch)
	f.mu.Unlock()
	<-ch
}

func (f *fifo) Unlock() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.wait) > 0 {
		ch := f.wait[0]
		f.wait = f.wait[1:]
		close(ch)
		return
	}
	f.held = false
}
